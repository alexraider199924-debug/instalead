import { Router } from 'express';
import { getMoscowISO } from '../services/schedulerService.js';
import { getDailyBudget, getBudgetUsedToday, spendBudget } from './lead-finder.js';
import { enrichProfiles, ENRICH_VERSION, ENRICH_LIMITS } from '../services/contactEnrichService.js';
import { readAgentContextMap } from '../services/offerContext.js';
import { createEnrichJob, jobWithProgress, enrichReadiness } from '../services/contactEnrichJob.js';
import { notify } from '../services/notifier.js';

const router = Router();

// Never run two summary passes for the same job concurrently. The scrape
// endpoint now returns before AI work finishes, so polling can otherwise start
// a second pass against the same rows.
const activeSummaryJobs = new Set();

async function runSummaryPassLocked(db, jobId, maxBatches = 2) {
  if (activeSummaryJobs.has(Number(jobId))) return 0;
  activeSummaryJobs.add(Number(jobId));
  try {
    return await runSummaryPass(db, jobId, maxBatches);
  } finally {
    activeSummaryJobs.delete(Number(jobId));
  }
}

// ---------------------------------------------------------------------------
// Pacing.
//
// Enrichment is the lowest-priority Instagram consumer in the system: it never
// runs while a campaign is sending or while Lead Finder / AI Search have work,
// and it time-boxes itself into resumable blocks. That makes "run it in the
// background overnight" the default rather than something the user has to
// babysit — the job survives the extension disconnecting and picks up where it
// stopped.
//
// Delays are decided here and shipped with the task, so pacing cannot be
// shortened by editing the extension.
// ---------------------------------------------------------------------------
// Declared in the service next to the batch size it derives from, so pacing and
// batch size cannot drift apart.
export { ENRICH_LIMITS };

const randBetween = (min, max) => Math.round(min + Math.random() * (max - min));

// last_progress_at is written in UTC and ONLY ever compared against SQLite's
// datetime('now'), which is UTC. The rest of the app stamps rows with
// getMoscowISO(), and mixing the two here would silently skew every time-box
// comparison by three hours: a job started at 12:00 Moscow would look 20
// minutes old only six hours later, so the "run for an hour, then pause"
// behaviour the feature is built on would never fire.
//
// Displayed timestamps keep using getMoscowISO() like everything else; this
// one column is the exception, and the format is ISO-8601 precisely because
// julianday() parses it unambiguously.
const nowUtc = () => new Date().toISOString();

function budgetState(db) {
  const limit = getDailyBudget(db);
  const used = getBudgetUsedToday(db);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

const normalizeUsername = value =>
  String(value || '').trim().replace(/^@/, '').toLowerCase();

// A missing key or a rejected one fails identically on every single retry.
// Retrying it costs a full scrape cycle — real Instagram requests against a
// real account — to produce exactly zero notes again, which is how one bad
// setting quietly burned a whole contact list. These are stop-and-tell-the-user
// errors; everything else is worth another pass.
const PERMANENT_AI_ERRORS = [
  /ключ не настроен/i,
  /Invalid OpenRouter API key/i,
  /\b401\b/,
  /\b403\b/,
  /не-JSON/i,
];

function isPermanentAiError(message) {
  return PERMANENT_AI_ERRORS.some(re => re.test(String(message || '')));
}

// The upstream error text is English API-speak. It is shown to a user who has
// never seen OpenRouter, so each known cause gets its own sentence and a place
// to go next.
function aiErrorHint(message) {
  const text = String(message || '');
  if (/ключ не настроен/i.test(text)) {
    return 'Не задан API-ключ ИИ. Добавьте его в «Интеграции» — без него конспект составить некому.';
  }
  if (/Invalid OpenRouter API key|\b401\b/.test(text)) {
    return 'API-ключ ИИ отклонён OpenRouter. Проверьте ключ в «Интеграциях».';
  }
  if (/\b403\b/.test(text)) {
    return 'OpenRouter не пускает этот ключ к выбранной модели. Смените модель или ключ в «Интеграциях».';
  }
  if (/не-JSON/i.test(text)) {
    return 'Модель вернула не-JSON ответ. Смените модель в «Интеграциях» на ту, что поддерживает JSON-режим.';
  }
  return `ИИ не отвечает: ${text.slice(0, 200)}`;
}

// One place decides whether a job is finished, because three callers used to
// disagree about it and a job that only closed itself on the extension's next
// poll sat at 0% forever once the browser was closed.
function isJobFinished(db, jobId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN scraped = 0 AND summarized = 0 THEN 1 ELSE 0 END) AS pending
    FROM contact_enrich_results WHERE job_id = ?
  `).get(jobId);
  // A job with no result rows at all is not "finished", it never started.
  return (row?.total || 0) > 0 && (row?.pending || 0) === 0;
}

// Called from the read endpoints so a job closes itself the moment its last row
// is banked, without waiting for an extension that may never come back.
// Exported for the test that pins the behaviour — this is the difference between
// a job that closes itself and one that reads 0% forever.
export function autoFinish(db, jobId) {
  const job = db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(jobId);
  if (!job || !['pending', 'running'].includes(job.status)) return null;
  if (!isJobFinished(db, jobId)) return null;
  const done = finishJob(db, jobId);
  console.log(`[ContactEnrich] Job #${jobId} auto-finished: every contact is accounted for`);
  return done;
}

// Why a job that is not moving is not moving, in words the UI can show. An
// open-ended "0%" is the one screen a user cannot act on.
function stalledReason(db, job) {
  if (!job || !['pending', 'running'].includes(job.status)) return null;

  // Instagram's cooldown outranks the idle timer. While it lasts the extension
  // is connected and polling; every poll answers "still waiting". Reporting the
  // extension as offline here would send the user to debug the one part that
  // works, and the bar would stay frozen with no other clue.
  if (job.ig_backoff_until) {
    const until = new Date(job.ig_backoff_until);
    if (Number.isNaN(until.getTime()) || until.getTime() > Date.now()) {
      const clock = Number.isNaN(until.getTime())
        ? ''
        : ` до ${until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК`;
      return `Instagram ограничил запросы к профилям${clock}. Обогащение продолжится само — расширение подхватит задачу, когда пауза закончится.`;
    }
  }

  const row = db.prepare(`
    SELECT (julianday('now') - julianday(COALESCE(last_progress_at, created_at))) * 1440 AS minutes
    FROM contact_enrich_jobs WHERE id = ?
  `).get(job.id);
  const idle = row?.minutes ?? 0;

  // Two minutes is longer than a normal batch (10 profiles, 20-45 s cooldown)
  // but far shorter than the "abandoned" threshold — this is the window where
  // the honest answer is "the extension has not picked it up yet".
  if (idle > 2) {
    return `Нет движения ${Math.round(idle)} мин — расширение не подключено или не опрашивает задачу. Откройте Chrome с расширением Instalead.`;
  }
  return null;
}

function setStatus(db, id, status, extra = {}) {
  const finished = ['completed', 'failed', 'cancelled'].includes(status);
  db.prepare(`
    UPDATE contact_enrich_jobs
    SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?,
        finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
    WHERE id = ?
  `).run(status, extra.error_message ?? null, getMoscowISO(), finished ? 1 : 0, getMoscowISO(), id);
  console.log(`[ContactEnrich] Job #${id} → ${status}${extra.error_message ? `: ${extra.error_message}` : ''}`);
  return db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(id);
}

// progress + the "why is it not moving" sentence, so no caller has to
// remember to add the second one.
function decorate(db, job) {
  const progress = jobWithProgress(db, job);
  if (!progress) return null;
  const stalled = stalledReason(db, job);
  return {
    ...progress,
    stalled_reason: stalled,
    // Everything is banked but the status still says running — treat it as done
    // in the UI rather than showing a bar that can only go one way.
    all_rows_done: ['pending', 'running'].includes(job.status) && progress.pending === 0 && progress.total > 0
  };
}

// ---------------------------------------------------------------------------
// Web UI endpoints
// ---------------------------------------------------------------------------

router.get('/limits', (req, res) => {
  res.json({ limits: ENRICH_LIMITS, budget: budgetState(req.db) });
});

// What the UI asks before offering to start anything. Answering this from one
// place is what keeps "обогатить" from silently reading ten profiles and
// producing no notes: the same answer gates the button, gates the POST, and is
// rendered as the reason a run cannot start.
router.get('/readiness', (req, res) => {
  const db = req.db;
  res.json({ ...enrichReadiness(db), budget: budgetState(db) });
});

// Only one enrichment job at a time. The other job systems each enforce the
// same for themselves; this is the remaining direction of the conflict, since
// enrichment is the one that must yield.
router.get('/jobs', (req, res) => {
  const db = req.db;
  // Close finished jobs on read: the user opening the dialog is itself proof
  // that no extension heartbeat is going to finish it for us.
  for (const row of db.prepare(
    `SELECT id FROM contact_enrich_jobs WHERE status IN ('pending','running')`
  ).all()) {
    autoFinish(db, row.id);
  }

  const jobs = db.prepare(
    'SELECT * FROM contact_enrich_jobs ORDER BY id DESC LIMIT 20'
  ).all().map(j => decorate(db, j));
  res.json({
    jobs,
    active: jobs.find(j => ['pending', 'running'].includes(j.status)) || null
  });
});

router.get('/jobs/:id', (req, res) => {
  const db = req.db;
  autoFinish(db, req.params.id);

  const job = decorate(db, db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(req.params.id));
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  const results = db.prepare(
    'SELECT username, full_name, summary, hooks, scraped, summarized, error FROM contact_enrich_results WHERE job_id = ? ORDER BY summarized ASC, id ASC LIMIT 200'
  ).all(job.id);
  res.json({ job, results });
});

// The UI's per-row error is the first thing anyone reads when a job looks
// stuck, so it has to be actionable: a private profile says so plainly, while an
// AI or Instagram failure carries the upstream text that names the cause.
function rowErrorText(row) {
  if (row.error) return row.error;
  if (row.scraped === 1 && row.summarized === 1) return 'Конспект не создан';
  if (row.scraped === 1) return 'Профиль прочитан, конспект ещё не создан';
  return null;
}

router.post('/jobs', (req, res) => {
  const db = req.db;
  const ids = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : [];
  const rawUsernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];

  // Normalization (@-strip, lowercase, dedupe) happens inside createEnrichJob
  // so the batch endpoint and the single-contact shortcut cannot disagree
  // about what counts as the same person.
  const usernames = ids.length
    ? db.prepare(`SELECT username FROM contacts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.username)
    : rawUsernames;

  const unique = [...new Set(usernames.filter(Boolean))];
  if (!unique.length) return res.status(400).json({ error: 'Не выбрано ни одного контакта' });
  if (unique.length > ENRICH_LIMITS.MAX_CONTACTS_PER_JOB) {
    return res.status(400).json({ error: `Максимум ${ENRICH_LIMITS.MAX_CONTACTS_PER_JOB} контактов за раз` });
  }

  // Checked before the job exists, not after the first batch. Starting a job
  // with no API key spends Instagram-side activity on profiles whose notes can
  // never be written, and the failure only surfaces ten profiles later.
  const readiness = enrichReadiness(db);
  const noKey = readiness.blockers.find(b => b.code === 'no_ai_key');
  if (noKey) {
    return res.status(400).json({ error: noKey.message, blockers: readiness.blockers, fix: noKey.fix });
  }

  const active = readiness.active_job;
  if (active) {
    return res.status(409).json({
      error: `Обогащение уже идёт. Поставьте текущую задачу на паузу или дождитесь конца.`,
      job_id: active.id,
      blockers: readiness.blockers
    });
  }

  // Surfaced in the response rather than only logged: a user who starts a run
  // with the extension closed should know immediately that it will sit idle
  // until they open Chrome, not learn it from a stalled bar three minutes on.
  const warnings = readiness.warnings.map(w => w.message);

  const runMinutes = Math.min(
    ENRICH_LIMITS.MAX_RUN_MINUTES,
    Math.max(0, Number(req.body?.run_minutes) || ENRICH_LIMITS.DEFAULT_RUN_MINUTES)
  );

  // createEnrichJob returns the stored row, not the id — feeding it back into
  // a `WHERE id = ?` lookup silently matched nothing and answered {"job":null}.
  const job = jobWithProgress(db, createEnrichJob(db, { usernames: unique, runMinutes }));
  if (!job) return res.status(500).json({ error: 'Не удалось создать задачу' });
  res.status(201).json({ job, warnings });
});

router.post('/jobs/:id/pause', (req, res) => {
  res.json({ job: jobWithProgress(req.db, setStatus(req.db, req.params.id, 'paused')) });
});

router.post('/jobs/:id/resume', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  if (job.status === 'completed') return res.status(400).json({ error: 'Задача уже завершена' });

  // Resuming a paused job restarts its block clock. Without this the job would
  // immediately re-pause on the very next /task poll, because the time-box is
  // measured from the last progress rather than from the resume.
  //
  // The error counter resets too. Pressing «Продолжить» means the user has
  // gone and fixed whatever the error said — carrying the old count forward
  // would make the very next hiccup trip the threshold instantly and pause the
  // job again before it had tried anything.
  setStatus(db, job.id, 'pending', { error_message: null });
  db.prepare('UPDATE contact_enrich_jobs SET last_progress_at = ?, error_message = NULL, consecutive_errors = 0 WHERE id = ?')
    .run(nowUtc(), job.id);
  res.json({ job: jobWithProgress(db, db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(job.id)) });
});

router.post('/jobs/:id/cancel', (req, res) => {
  const db = req.db;
  setStatus(db, req.params.id, 'cancelled');

  // Every row of this job that never got a note goes back to "not enriched",
  // whatever stage it stopped at. The old predicate only caught rows that had
  // never been scraped, so a profile that was read fine and then lost because
  // the AI pass failed stayed 'queued' forever — invisible to the "needs a
  // note" filter and impossible to re-run from the Contacts table.
  db.transaction(() => {
    db.prepare(`
      UPDATE leads SET enrich_status = 'none', enrich_error = NULL
      WHERE username IN (
        SELECT username FROM contact_enrich_results
        WHERE job_id = ? AND (summary IS NULL OR summary = '')
      )
    `).run(req.params.id);

    db.prepare(`
      UPDATE contact_enrich_results
      SET summarized = 1, error = COALESCE(error, 'Задача остановлена до составления конспекта')
      WHERE job_id = ? AND (summary IS NULL OR summary = '')
    `).run(req.params.id);
  })();

  res.json({ job: jobWithProgress(db, db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(req.params.id)) });
});

// Reviewing a note is the whole point of storing it. Edited text is written
// back to leads so the next send uses what a human decided, and the result row
// is kept in sync so a re-opened job shows the same thing.
router.post('/results/:id', (req, res) => {
  const db = req.db;
  const row = db.prepare('SELECT * FROM contact_enrich_results WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Результат не найден' });

  const summary = req.body?.summary !== undefined ? String(req.body.summary) : row.summary;
  const hooks = req.body?.hooks !== undefined ? req.body.hooks : row.hooks;

  const hooksJson = hooks === null || hooks === undefined ? row.hooks : JSON.stringify(hooks);
  const meta = JSON.stringify({
    version: ENRICH_VERSION,
    edited: true,
    hooks: safeParse(hooksJson, []),
    created_at: new Date().toISOString()
  });

  db.transaction(() => {
    db.prepare('UPDATE contact_enrich_results SET summary = ?, hooks = ?, meta = ? WHERE id = ?')
      .run(summary, hooksJson, meta, row.id);
    db.prepare(`
      UPDATE leads SET profile_summary = ?, profile_summary_meta = ?, profile_enriched_at = ?, enrich_status = 'done'
      WHERE username = ?
    `).run(summary, meta, getMoscowISO(), row.username);
  })();

  res.json({ success: true });
});

function safeParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Extension-facing endpoints
// ---------------------------------------------------------------------------

function reclaimStaleJobs(db) {
  // The extension going away is not a failure — the job simply stops and picks
  // up again when it comes back. Only genuinely abandoned runs are reclaimed,
  // so this must not race the block expiry in blockExpired(): a normal
  // one-hour block finishing is the user's own stop, not a disconnect.
  //
  // julianday(), not a string comparison: last_progress_at is stored ISO-8601
  // ("2026-10-04T19:44:19.123Z") while datetime('now') is space-separated
  // ("2026-10-04 15:44:19"). Lexically those never compare correctly — at an
  // equal date prefix 'T' outranks ' ', so every stored timestamp looked to be
  // in the future and an abandoned job was never reclaimed at all.
  db.prepare(`
    UPDATE contact_enrich_jobs
    SET status = 'paused', error_message = 'Обогачение давно не продвигалось — нажмите «Продолжить», если оно ещё нужно'
    WHERE status = 'running'
      AND last_progress_at IS NOT NULL
      AND (julianday('now') - julianday(last_progress_at)) * 1440 >= ?
  `).run(ENRICH_LIMITS.DISCONNECT_MINUTES);
}

function blockExpired(db, job) {
  if (!job.run_minutes || !job.last_progress_at) return false;
  const row = db.prepare(
    `SELECT (julianday('now') - julianday(?)) * 1440 AS minutes`
  ).get(job.last_progress_at);
  return (row?.minutes ?? -1) >= job.run_minutes;
}

export async function getEnrichTask(db) {
  reclaimStaleJobs(db);

  // Yield to everything that matters more. Campaign sending is invisible to the
  // server (the extension holds it), but these two are ours to check.
  const busy = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM scrape_jobs WHERE status IN ('pending','running')) AS scrape,
       (SELECT COUNT(*) FROM lead_search_jobs WHERE status IN ('pending','running')) AS search`
  ).get();
  if (busy.scrape || busy.search) return { task: null };

  const job = db.prepare(
    `SELECT * FROM contact_enrich_jobs WHERE status IN ('pending','running') ORDER BY id ASC LIMIT 1`
  ).get();
  if (!job) return { task: null };

  // Rate limiting check: if we called Instagram recently, don't hand out more work
  if (job.last_instagram_call && Date.now() - job.last_instagram_call < 60000) {
    const remaining = Math.ceil((job.last_instagram_call + 60000 - Date.now()) / 1000);
    console.log(`[ContactEnrich] Job #${job.id} rate limited — waiting ${remaining}s`);
    return {
      task: null,
      message: `Instagram ограничил запросы, подождём ${remaining} сек, задача продолжится автоматически`
    };
  }

  const budget = budgetState(db);
  if (budget.remaining <= 0) {
    console.log(`[ContactEnrich] Job #${job.id} idle: daily budget spent (${budget.used}/${budget.limit})`);
    return {
      task: null,
      message: `Дневной бюджет запросов исчерпан (${budget.used}/${budget.limit}). Обогащение продолжится завтра.`,
    };
  }

  if (job.status === 'pending') {
    // last_progress_at is left alone when it already has a value: on resume it
    // was deliberately reset by POST /jobs/:id/resume, and overwriting it here
    // would make a paused job's block clock restart on every poll.
    db.prepare(`
      UPDATE contact_enrich_jobs
      SET status = 'running', updated_at = ?,
          last_progress_at = COALESCE(last_progress_at, ?)
      WHERE id = ?
    `).run(getMoscowISO(), nowUtc(), job.id);
  }

  // Mark when Instagram was last called for this job
  if (job.status === 'running') {
    db.prepare('UPDATE contact_enrich_jobs SET last_instagram_call = ? WHERE id = ?')
      .run(Date.now(), job.id);
  }

  const fresh = db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(job.id);
  // Checked after the pending→running promotion so a freshly created job is
  // never judged by an inherited clock, but before any work is handed out.
  if (blockExpired(db, fresh)) {
    setStatus(db, fresh.id, 'paused', { error_message: `Блок на ${fresh.run_minutes} мин завершён. Нажмите «Продолжить» для следующего блока.` });
    return { task: null, message: `Текущий блок обогащения на ${fresh.run_minutes} мин завершён. Нажмите «Продолжить».` };
  }

  // Phase 2 first, whenever anything is waiting for it. The pass normally runs
  // inline from the scraped report, but that report is one HTTP request on a
  // browser that can be closed mid-flight — and a lost report left ten profiles
  // read with no note and no trigger to retry them, which is exactly the
  // "профили прочитаны, а конспектов нет" state this feature was reported for.
  // The poll is the reliable driver; the inline call is just the fast path.
  const waiting = db.prepare(
    'SELECT COUNT(*) AS cnt FROM contact_enrich_results WHERE job_id = ? AND scraped = 1 AND summarized = 0'
  ).get(job.id).cnt;
  if (waiting > 0) {
    try {
      await runSummaryPassLocked(db, job.id, 2);
    } catch (e) {
      console.error(`[ContactEnrich] Job #${job.id} summary pass failed:`, e.message);
    }
    // The pass can pause the job (a dead API key, or a model that answers with
    // nothing). Handing out fresh scrapes after that would read more profiles
    // for notes nobody is going to write.
    const after = db.prepare('SELECT status, error_message FROM contact_enrich_jobs WHERE id = ?').get(job.id);
    if (after && !['pending', 'running'].includes(after.status)) {
      return {
        task: null,
        message: after.error_message || `Обогащение: ${after.status}`
      };
    }
  }

  // If the scrape endpoint has already queued an AI pass, let it finish
  // before asking Instagram for another batch. This keeps memory/queue growth
  // bounded and prevents the browser from outrunning the model.
  if (activeSummaryJobs.has(Number(job.id))) {
    return { task: null, message: 'Конспекты обрабатываются моделью — следующая партия будет выдана после завершения AI.' };
  }

  // Phase 1: read profiles from Instagram.
  const batchSize = Math.min(ENRICH_LIMITS.BATCH_SIZE, budget.remaining);
  const targets = db.prepare(`
    SELECT username FROM contact_enrich_results
    WHERE job_id = ? AND scraped = 0 AND summarized = 0
    ORDER BY id ASC LIMIT ?
  `).all(job.id, batchSize).map(r => r.username);

  if (targets.length === 0) {
    return finishJob(db, job.id);
  }

  const scrapedSoFar = db.prepare(
    'SELECT COUNT(*) AS cnt FROM contact_enrich_results WHERE job_id = ? AND scraped = 1'
  ).get(job.id).cnt;
  const resting = scrapedSoFar > 0 && scrapedSoFar % ENRICH_LIMITS.BATCH_SIZE === 0;

  console.log(
    `[ContactEnrich] Job #${job.id} → extension: ${targets.length} profile(s)` +
    (resting ? ', rest between batches' : '') +
    `, delay ${resting ? 'cooldown' : 'normal'}`
  );

  return {
    task: {
      type: 'enrich_contacts',
      job_id: job.id,
      usernames: targets,
      delay_ms: resting
        ? randBetween(ENRICH_LIMITS.COOLDOWN_MIN_MS, ENRICH_LIMITS.COOLDOWN_MAX_MS)
        : randBetween(ENRICH_LIMITS.DELAY_MIN_MS, ENRICH_LIMITS.DELAY_MAX_MS),
      // Spacing the extension must leave between two profiles inside this
      // batch. Shipped rather than hard-coded in the extension for the same
      // reason delay_ms is: pacing decided in two places is pacing that
      // eventually disagrees with itself.
      profile_gap_ms: randBetween(ENRICH_LIMITS.PROFILE_GAP_MIN_MS, ENRICH_LIMITS.PROFILE_GAP_MAX_MS),
      resting,
      progress: jobWithProgress(db, fresh),
    },
    budget
  };
}

// Phase 2: run the AI pass. Called inline from the scraped report while the
// extension is resting, so by the time the next task is due the notes are
// already stored. A failure here is banked and retried — getEnrichTask will
// hand the same rows back to the AI pass on the next poll.
async function runSummaryPass(db, jobId, maxBatches = 2) {
  const agentContext = readAgentContextMap(db);
  let written = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = db.prepare(`
      SELECT username, full_name, bio, follower_count, post_count, external_url, is_private, posts_json
      FROM contact_enrich_results
      WHERE job_id = ? AND scraped = 1 AND summarized = 0
      ORDER BY id ASC LIMIT ?
    `).all(jobId, ENRICH_LIMITS.BATCH_SIZE);

    if (!rows.length) break;

    const prepared = rows.map(r => ({
      username: r.username,
      full_name: r.full_name,
      bio: r.bio,
      follower_count: r.follower_count,
      post_count: r.post_count,
      external_url: r.external_url,
      is_private: !!r.is_private,
      posts: safeParse(r.posts_json, [])
    }));

    let notes;
    try {
      notes = await enrichProfiles(db, prepared, {
        agentContext,
        maxPosts: ENRICH_LIMITS.MAX_POSTS_PER_PROFILE
      });
    } catch (e) {
      const human = String(e?.message || e).slice(0, 300);
      const permanent = isPermanentAiError(human);
      const jobRow = db.prepare('SELECT consecutive_errors FROM contact_enrich_jobs WHERE id = ?').get(jobId);
      // A permanent cause is not retried at all — one attempt is enough to know
      // that every further attempt will fail identically.
      const attempts = permanent
        ? ENRICH_LIMITS.MAX_CONSECUTIVE_ERRORS
        : (jobRow?.consecutive_errors || 0) + 1;
      const reason = aiErrorHint(human);
      console.error(`[ContactEnrich] Job #${jobId} summary batch failed${permanent ? ' (неисправимо)' : ''}:`, e);

      // The lead rows first. A contact left at "в очереди" with no reason is
      // exactly what gets reported as "обогащение сломано" — it looks stuck
      // forever in the Contacts table with nothing to click.
      db.prepare(`
        UPDATE leads SET enrich_status = 'failed', enrich_error = ?
        WHERE username IN (
          SELECT username FROM contact_enrich_results WHERE job_id = ? AND summarized = 0
        )
      `).run(reason, jobId);
      db.prepare(`
        UPDATE contact_enrich_results SET error = ? WHERE job_id = ? AND scraped = 1 AND summarized = 0
      `).run(reason, jobId);

      // Then the job itself: stopped, with a sentence that says what to fix.
      // Left running it would keep pulling new batches off Instagram to feed a
      // model that cannot answer.
      if (attempts >= ENRICH_LIMITS.MAX_CONSECUTIVE_ERRORS) {
        setStatus(db, jobId, 'paused', {
          error_message: `${reason} Обогащение на паузе — исправьте и нажмите «Продолжить».`
        });
      } else {
        db.prepare(`
          UPDATE contact_enrich_jobs SET consecutive_errors = ?, error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(attempts, `${reason} Попытка ${attempts} из ${ENRICH_LIMITS.MAX_CONSECUTIVE_ERRORS}.`, getMoscowISO(), jobId);
      }
      break;
    }

    // Usable notes, not map entries: a profile answered with an empty summary
    // produced nothing, and a batch where every summary came back empty is the
    // same failure as a batch where the model said nothing at all.
    const produced = [...notes.values()].filter(n => n?.summary).length;
    if (produced === 0) {
      console.warn(
        `[ContactEnrich] Job #${jobId}: модель вернула 0 заметок на ${prepared.length} профилей — ` +
        'проверьте модель и лимит токенов в Настройках'
      );
    }

    const write = db.prepare(`
      UPDATE contact_enrich_results SET summary = ?, hooks = ?, meta = ?, summarized = 1 WHERE job_id = ? AND username = ?
    `);
    const writeLead = db.prepare(`
      UPDATE leads SET profile_summary = ?, profile_summary_meta = ?, profile_enriched_at = ?,
        enrich_status = 'done', enrich_error = NULL
      WHERE username = ?
    `);
    // A row the model returned nothing for is still closed, but it must not be
    // left looking "queued" in the Contacts table. Marking it failed with a
    // reason puts it back in the "needs a note" filter, where it can be retried
    // — instead of disappearing into a permanent in-progress state.

    let batchWritten = 0;
    db.transaction(() => {
      for (const row of prepared) {
        const note = notes.get(row.username);
        const hooksJson = note ? JSON.stringify(note.hooks) : null;
        const metaJson = note ? JSON.stringify(note.meta) : null;

        write.run(note?.summary || null, hooksJson, metaJson, jobId, row.username);
        if (note?.summary) {
          writeLead.run(note.summary, metaJson, getMoscowISO(), row.username);
          batchWritten++;
        } else {
          // A profile with no usable bio/captions is a valid 'no data' result,
          // not an AI error. Do not poison the job with a red failure state.
          db.prepare(`UPDATE leads SET enrich_status = 'none', enrich_error = NULL WHERE username = ?`).run(row.username);
        }
      }
    })();

    written += batchWritten;
    const missed = prepared.filter(r => !notes.get(r.username)?.summary);
    if (missed.length) {
      console.warn(
        `[ContactEnrich] Job #${jobId}: ${missed.length} профиль(ей) без заметки: ${missed.map(r => r.username).join(', ')}`
      );
    }
    console.log(`[ContactEnrich] Job #${jobId}: конспектов записано ${batchWritten}/${prepared.length}`);

    // Stop after an empty answer rather than looping: the whole batch failed,
    // not just part of it, and another pass right now would produce the same
    // nothing. Every row of THIS batch is already closed above — the old code
    // closed every scraped row of the job here, which silently discarded up to
    // ENRICH_BATCH profiles that were never even sent to the model.
    if (produced === 0) {
      // Never pause a whole enrichment job because a model response was
      // formatted differently. enrichProfiles already performed single-profile
      // repair and an extractive fallback. At this point the only legitimate
      // zero-result case is a profile with no readable source material. The job
      // remains healthy and the next batch can continue.
      console.warn(`[ContactEnrich] Job #${jobId}: текущая пачка не дала AI-note; продолжаю без паузы`);
    }
  }

  const counts = db.prepare(`
    SELECT SUM(CASE WHEN scraped = 1 THEN 1 ELSE 0 END) AS scraped,
           SUM(CASE WHEN summarized = 1 THEN 1 ELSE 0 END) AS summarized,
           SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN scraped = 0 AND summarized = 0 THEN 1 ELSE 0 END) AS pending
    FROM contact_enrich_results WHERE job_id = ?
  `).get(jobId);

  // "Done" is the same predicate the finish check uses — a row that closed as a
  // failure already has summarized = 1, so adding `failed` to `summarized`
  // counted every failure twice and could report "done" with work still queued.
  const doneAll = (counts?.pending || 0) === 0 && (counts?.scraped || 0) > 0;

  db.prepare(`
    UPDATE contact_enrich_jobs SET scraped_count = ?, summarized_count = ?, failed_count = ?,
      phase = ?, updated_at = ?, last_progress_at = ?, consecutive_errors = 0
    WHERE id = ?
  `).run(
    counts.scraped || 0,
    counts.summarized || 0,
    counts.failed || 0,
    doneAll ? 'done' : 'summarize',
    getMoscowISO(),
    nowUtc(),
    jobId
  );

  return written;
}

function finishJob(db, jobId) {
  const job = setStatus(db, jobId, 'completed');
  const done = jobWithProgress(db, job);
  notify(db.workspaceName, `Обогащение завершено: ${done.summarized} конспектов, ${done.failed} без данных.`, {
    key: `enrich-done:${jobId}`
  }).catch(() => {});
  return { task: null, job_completed: jobId, message: `Обогащение завершено`, job: done };
}

router.get('/task', async (req, res) => {
  try {
    res.json(await getEnrichTask(req.db));
  } catch (e) {
    console.error('[ContactEnrich] task error:', e.message);
    res.status(500).json({ task: null, error: e.message });
  }
});

router.post('/task/:id/scraped', async (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const profiles = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
  // Profiles actually came back, so any Instagram cooldown on this job is over.
  // Cleared here rather than when the task was handed out: during a cooldown the
  // extension keeps polling and would wipe the notice before it ever expired.
  if (profiles.length) {
    db.prepare('UPDATE contact_enrich_jobs SET ig_backoff_until = NULL WHERE id = ?').run(job.id);
  }
  const update = db.prepare(`
    UPDATE contact_enrich_results
    SET scraped = 1, bio = ?, full_name = COALESCE(NULLIF(?, ''), full_name),
        follower_count = ?, post_count = ?, external_url = ?, is_private = ?,
        posts_json = ?, error = NULL
    WHERE job_id = ? AND username = ?
  `);
  const markFailed = db.prepare(
    `UPDATE contact_enrich_results SET scraped = 1, summarized = 1, error = ? WHERE job_id = ? AND username = ?`
  );
  const resetLead = db.prepare('UPDATE leads SET enrich_status = ?, enrich_error = ? WHERE username = ?');

  let ok = 0;
  let failed = 0;
  const failedDetail = [];
  db.transaction(() => {
    for (const p of profiles) {
      const username = normalizeUsername(p?.username);
      if (!username) continue;

      const posts = Array.isArray(p?.posts) ? p.posts.filter(Boolean).slice(0, ENRICH_LIMITS.MAX_POSTS_PER_PROFILE * 2) : [];
      // A profile with neither a bio nor a single post caption has nothing to
      // summarize. Private accounts without a bio fall here, and they are the
      // bulk of a cold list — treating them as failures keeps them out of the
      // "needs a note" filter instead of filling it with empty notes.
      const hasMaterial = !!String(p?.bio || '').trim() || posts.length > 0;

      if (p?.error || !hasMaterial) {
        const reason = p?.error ? String(p.error).slice(0, 200) : 'Нет публичных данных (приватный профиль или пустое био)';
        markFailed.run(reason, job.id, username);
        resetLead.run('failed', reason, username);
        failedDetail.push(`@${username} — ${reason}`);
        failed++;
        continue;
      }

      update.run(
        String(p.bio || '').slice(0, 1000) || null,
        p.full_name || '',
        Number.isFinite(Number(p.follower_count)) ? Number(p.follower_count) : null,
        Number.isFinite(Number(p.post_count)) ? Number(p.post_count) : null,
        p.external_url || null,
        p.is_private ? 1 : 0,
        JSON.stringify(posts),
        job.id,
        username
      );
      ok++;
    }
  })();

  // Per-contact reasons are the difference between "1 без данных" and a line
  // that says whether the account is private, rate-limited, or simply empty.
  if (failedDetail.length) {
    console.log(`[ContactEnrich] Job #${job.id} — без данных (${failed}):\n  ${failedDetail.join('\n  ')}`);
  }
  console.log(`[ContactEnrich] Job #${job.id} ← extension: прочитано ${ok}, без данных ${failed}`);

  db.prepare(`
    UPDATE contact_enrich_jobs SET scraped_count = ?, consecutive_errors = 0, phase = 'summarize',
      updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(
    db.prepare('SELECT COUNT(*) AS cnt FROM contact_enrich_results WHERE job_id = ? AND scraped = 1').get(job.id).cnt,
    getMoscowISO(), nowUtc(), job.id
  );
  spendBudget(db, profiles.length);

  // IMPORTANT: do not await the LLM here. The extension must receive the
  // scrape acknowledgement immediately; otherwise a slow/empty model response
  // blocks the DOM worker and eventually looks like an Instagram scrape crash.
  // The rows are already persisted, so the backend can safely summarize them
  // after the HTTP response has gone back to the extension.
  res.json({ success: true, ok, failed, summarized: 0, summary_queued: true });

  setImmediate(() => {
    runSummaryPassLocked(db, job.id, 2).catch(e => {
      console.error(`[ContactEnrich] Job #${job.id} async summary failed:`, e.message);
    });
  });
});

router.post('/task/:id/error', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { error_message, rate_limited, resume_at } = req.body || {};
  const errors = (job.consecutive_errors || 0) + 1;

  // Rate limiting is expected and self-healing: the job goes quiet and resumes
  // on the next poll rather than dying, which is what keeps a background run
  // safe to leave alone.
  const shouldPause = errors >= ENRICH_LIMITS.MAX_CONSECUTIVE_ERRORS && !rate_limited;
  if (shouldPause) {
    setStatus(db, job.id, 'paused', { error_message: String(error_message || 'Слишком много ошибок подряд') });
  } else {
    db.prepare('UPDATE contact_enrich_jobs SET consecutive_errors = ?, error_message = ?, updated_at = ?, last_progress_at = ? WHERE id = ?')
      .run(errors, rate_limited ? null : String(error_message || '').slice(0, 200), getMoscowISO(), nowUtc(), job.id);
  }

  // The extension stops polling Instagram for 30-60 minutes after a 429, and
  // says nothing while it waits. Without this the job sits at 0% and the UI
  // reports the extension as disconnected — during the one period when it is
  // connected and behaving exactly as designed.
  if (rate_limited) {
    db.prepare('UPDATE contact_enrich_jobs SET ig_backoff_until = ? WHERE id = ?')
      .run(resume_at || new Date(Date.now() + 30 * 60_000).toISOString(), job.id);
  }

  res.json({ success: true, paused: shouldPause, consecutive_errors: errors });
});

export default router;
