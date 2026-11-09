// Job creation shared by the batch endpoint and the single-contact shortcut, so
// "ИИ-обогатить" on a selection and on one row produce the identical job shape.
// Duplicating this transaction is how the two paths would drift — the shortcut
// would skip lead creation and the note would land nowhere.

import { getMoscowISO } from './schedulerService.js';
import { ENRICH_BATCH, ENRICH_LIMITS } from './contactEnrichService.js';

export function createEnrichJob(db, { usernames, runMinutes = 60 }) {
  const unique = [...new Set(
    (usernames || [])
      .map(u => String(u || '').trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  )];
  if (!unique.length) {
    console.warn('[ContactEnrich] createEnrichJob called with no usable usernames — no job created');
    return null;
  }

  const nameOf = db.prepare('SELECT full_name FROM contacts WHERE username = ?');

  const jobId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO contact_enrich_jobs (status, phase, total_count, run_minutes) VALUES (?, ?, ?, ?)'
    ).run('pending', 'scrape', unique.length, runMinutes);
    const id = Number(result.lastInsertRowid);

    const insertResult = db.prepare(
      'INSERT OR IGNORE INTO contact_enrich_results (job_id, username) VALUES (?, ?)'
    );
    // Contacts added by hand exist only in `contacts`; the send path joins
    // `leads`, so the row has to exist before a note can be written to it.
    // enrich_status is set on the insert too — leaving it to the column default
    // would make a brand-new lead read as "never enriched" while its job is
    // queued, and the Contacts filter would hide it.
    const upsertLead = db.prepare(`
      INSERT INTO leads (username, full_name, enrich_status) VALUES (?, ?, 'queued')
      ON CONFLICT(username) DO UPDATE SET enrich_status = 'queued', enrich_error = NULL
    `);
    const touchContact = db.prepare('UPDATE contacts SET updated_at = ? WHERE username = ?');

    for (const username of unique) {
      insertResult.run(id, username);
      upsertLead.run(username, nameOf.get(username)?.full_name || null);
      touchContact.run(getMoscowISO(), username);
    }
    return id;
  })();

  const created = db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(jobId);
  console.log(
    `[ContactEnrich] Job #${jobId} created: ${unique.length} contacts, block ${runMinutes} min` +
    (unique.length <= 5 ? ` (${unique.join(', ')})` : '')
  );
  return created;
}

// The decorated view the UI reads. Lives here rather than in a route so the
// batch endpoint and the single-contact shortcut answer with an identical
// shape — a raw row from one and a decorated one from the other is how a
// caller ends up reading progress.percent off a missing field.
export function jobWithProgress(db, job) {
  if (!job) return null;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN summarized = 1 THEN 1 ELSE 0 END) AS summarized,
      SUM(CASE WHEN scraped = 1 THEN 1 ELSE 0 END) AS scraped_rows,
      SUM(CASE WHEN summarized = 1 AND (summary IS NULL OR summary = '') THEN 1 ELSE 0 END) AS empty_notes,
      SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN scraped = 0 AND summarized = 0 THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total_rows
    FROM contact_enrich_results WHERE job_id = ?
  `).get(job.id);

  // "Done" means the row is closed, not that a note exists. A row is closed
  // once it has been summarized — the AI pass sets summarized=1 even on the
  // failure paths (markFailed, "the model returned no note"), so summing
  // `summarized + failed` counted the same row twice: a private profile with no
  // bio reported as both "Готово 1" and "Без данных 1", and pushed the bar past
  // 100%.
  const totalRows = counts?.total_rows || 0;
  const failed = counts?.failed || 0;
  const pending = counts?.pending || 0;
  const done = totalRows - pending;
  // Jobs created before total_count was stored keep 0 there. Falling back to the
  // number of real rows is what stops such a job from reading as an eternal 0%.
  const total = Math.max(job.total_count || 0, totalRows);

  return {
    ...job,
    total: total || job.total_count || 0,
    // Profiles actually read off Instagram. It used to report the summarized
    // count under this name, so the two phases of the pipeline were the same
    // number in the UI — and "прочитано растёт, конспектов нет" (the exact
    // signature of a broken AI pass) was impossible to see.
    scraped: counts?.scraped_rows || 0,
    summarized: (counts?.summarized || 0) - (counts?.empty_notes || 0),
    empty_notes: counts?.empty_notes || 0,
    failed,
    pending,
    done,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    // Rough wall-clock estimate from the server-side pacing, so the UI can tell
    // the user whether this is a two-minute job or a two-hour one before they
    // commit to it.
    estimated_minutes: estimateMinutes(total || job.total_count || 0)
  };
}

const MS_PER_MIN = 60_000;

// Wall clock for `total` profiles as the pipeline now actually runs: a gap
// between each pair of profiles inside a batch, one batch delay per batch, one
// cooldown between batches, and the AI pass on top.
//
// The previous estimate divided milliseconds by 2000 and then by 60, i.e. by
// 120000 instead of 60000 — every term came out at half the real duration. It
// also ignored the AI pass entirely, so a 1000-contact run was reported as
// roughly 35 minutes of a job that in practice takes hours. The user is asked
// to commit to this before starting, so it has to be roughly honest.
function estimateMinutes(total) {
  if (!total) return 0;
  const blocks = Math.ceil(total / ENRICH_LIMITS.BATCH_SIZE);
  const avg = (min, max) => (min + max) / 2;
  const gap = avg(ENRICH_LIMITS.PROFILE_GAP_MIN_MS, ENRICH_LIMITS.PROFILE_GAP_MAX_MS);
  const batchDelay = avg(ENRICH_LIMITS.DELAY_MIN_MS, ENRICH_LIMITS.DELAY_MAX_MS);
  const cooldown = avg(ENRICH_LIMITS.COOLDOWN_MIN_MS, ENRICH_LIMITS.COOLDOWN_MAX_MS);
  const AI_PER_BATCH_MS = 25_000;

  const ms =
    Math.max(0, total - 1) * gap +
    blocks * batchDelay +
    Math.max(0, blocks - 1) * cooldown +
    blocks * AI_PER_BATCH_MS;

  return Math.max(1, Math.round(ms / MS_PER_MIN));
}

// ---------------------------------------------------------------------------
// Readiness
//
// Enrichment is the one job in this system with a hard external dependency that
// is not under the server's control: profiles are read by a browser extension
// logged into someone's Instagram, and the notes are written by a model the
// user paid for separately. Neither fact was visible anywhere — a user with no
// API key could press "ИИ-обогатить", watch ten profiles get read, and end up
// with a job that reported success and produced nothing.
//
// One function, so the batch endpoint, the single-contact shortcut and the UI
// cannot disagree about whether enrichment can run right now.
// ---------------------------------------------------------------------------

const HEARTBEAT_FRESH_MS = 60_000;

function readExtensionState(db) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'extension_heartbeat'`).get();
  if (!row?.value) return { online: false, age_seconds: null, ig_username: null };
  try {
    const data = JSON.parse(row.value);
    const age = Date.now() - new Date(data.timestamp).getTime();
    return {
      online: age < HEARTBEAT_FRESH_MS,
      age_seconds: Math.max(0, Math.round(age / 1000)),
      ig_username: data.ig_username || null
    };
  } catch {
    return { online: false, age_seconds: null, ig_username: null };
  }
}

export function enrichReadiness(db) {
  const key = db.prepare(`SELECT value FROM settings WHERE key = 'openrouter_api_key'`).get();
  const hasAiKey = Boolean(String(key?.value || '').trim());
  const extension = readExtensionState(db);
  const active = db.prepare(
    `SELECT id, status, total_count FROM contact_enrich_jobs WHERE status IN ('pending','running')`
  ).get();

  const blockers = [];
  const warnings = [];

  // The only hard blocker. Without it no note can ever be written, so a job
  // started here would read profiles — burning Instagram-side activity and
  // account headroom — and still produce nothing. Refusing to start is the
  // difference between "fix the key" and "wait an hour for a job that cannot
  // succeed".
  if (!hasAiKey) {
    blockers.push({
      code: 'no_ai_key',
      title: 'Не задан API-ключ ИИ',
      message: 'Без него никто не прочитает профили и не напишет конспект — задача прочитает их и останется пустой.',
      fix: '/integrations'
    });
  }

  if (active) {
    blockers.push({
      code: 'job_active',
      title: `Обогащение уже идёт`,
      message: 'Одновременно читаются профили в одном потоке. Дождитесь конца текущей задачи или остановите её.',
      fix: null,
      job_id: active.id
    });
  }

  // Not a blocker: the job is resumable and the extension may legitimately be
  // closed right now. But it is the one thing users misread as "broken", so it
  // is said out loud before they start rather than two minutes after.
  if (!extension.online) {
    warnings.push({
      code: 'extension_offline',
      title: 'Расширение не на связи',
      message: extension.age_seconds == null
        ? 'Профили читает расширение Instalead в Chrome. Пока его нет, задача стоит на «ожидает расширения» — это не поломка.'
        : `Расширение не отвечает уже ${Math.max(1, Math.round(extension.age_seconds / 60))} мин. Задача продолжится сама, как только откроют Chrome с Instalead.`,
      fix: null
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    has_ai_key: hasAiKey,
    extension,
    active_job: active || null,
    limits: {
      max_contacts_per_job: ENRICH_LIMITS.MAX_CONTACTS_PER_JOB,
      batch_size: ENRICH_LIMITS.BATCH_SIZE,
      default_run_minutes: ENRICH_LIMITS.DEFAULT_RUN_MINUTES,
      posts_per_profile: ENRICH_LIMITS.MAX_POSTS_PER_PROFILE
    }
  };
}