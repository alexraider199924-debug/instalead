import { Router } from 'express';
import { getMoscowISO } from '../services/schedulerService.js';

const router = Router();

// ---------------------------------------------------------------------------
// Pacing / safety constants.
//
// These live on the server, not in the extension, so the pacing can't be
// bypassed by editing extension code or replaying a task response. The
// extension asks "what should I do next?" and the server also tells it how
// long to wait first.
//
// Reference points for why these numbers: a person scrolling a follower list
// in the Instagram web UI triggers a page load every 1-3 seconds. We are
// deliberately 4-10x slower than that. The real ban risk with scraping is
// total daily volume rather than per-request speed, which is what
// DEFAULT_DAILY_BUDGET covers.
// ---------------------------------------------------------------------------
export const SCRAPE_LIMITS = {
  // Followers list: one request returns up to PAGE_SIZE users.
  PAGE_SIZE: 50,
  // Burst-then-rest rather than a uniform gap. A person scrolling a follower
  // list loads pages quickly for a while and then stops; a metronome does not.
  // Short gap between pages inside a burst...
  PAGE_DELAY_MIN_MS: 3500,
  PAGE_DELAY_MAX_MS: 8500,
  // ...then a long pause every PAGE_COOLDOWN_EVERY pages.
  PAGE_COOLDOWN_EVERY: 5,
  PAGE_COOLDOWN_MIN_MS: 30000,
  PAGE_COOLDOWN_MAX_MS: 45000,
  // Profile enrichment: one request per user, so this is the expensive phase.
  ENRICH_DELAY_MIN_MS: 2500,
  ENRICH_DELAY_MAX_MS: 6500,
  // How many users to enrich per extension round-trip. Kept small so a
  // block signal stops us quickly rather than mid-batch.
  ENRICH_BATCH: 5,
  // Rest between enrichment batches, same burst-then-rest reasoning.
  ENRICH_COOLDOWN_MIN_MS: 30000,
  ENRICH_COOLDOWN_MAX_MS: 90000,
  // Total Instagram requests per day this workspace may spend on scraping.
  // Campaign sending is budgeted separately by daily_limit.
  DEFAULT_DAILY_BUDGET: 1500,
  // Job-level caps. 500 per run is deliberately far below what the follower
  // endpoint would allow: total daily volume is what gets an account flagged,
  // not request speed. Collect more by running additional jobs across days.
  MAX_REQUESTED_COUNT: 500,
  MIN_REQUESTED_COUNT: 1,
  // Consecutive failed rounds before we pause the job on its own.
  MAX_CONSECUTIVE_ERRORS: 3,
  // A running job whose extension went away is reclaimed after this long.
  STALE_JOB_MINUTES: 15,
};

function randBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function moscowToday() {
  return getMoscowISO().slice(0, 10);
}

export function getDailyBudget(db) {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'scrape_daily_budget'`).get();
    const n = Number(row?.value);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (e) {}
  return SCRAPE_LIMITS.DEFAULT_DAILY_BUDGET;
}

export function getBudgetUsedToday(db) {
  try {
    const row = db.prepare('SELECT scrape_requests FROM ig_request_budget WHERE day = ?').get(moscowToday());
    return row?.scrape_requests || 0;
  } catch (e) {
    return 0;
  }
}

export function spendBudget(db, requests) {
  if (!requests || requests <= 0) return;
  const day = moscowToday();
  db.prepare(`
    INSERT INTO ig_request_budget (day, scrape_requests) VALUES (?, ?)
    ON CONFLICT(day) DO UPDATE SET scrape_requests = scrape_requests + ?
  `).run(day, requests, requests);
}

function budgetState(db) {
  const limit = getDailyBudget(db);
  const used = getBudgetUsedToday(db);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// Rough wall-clock estimate so the UI can warn before a job is started.
// Includes the burst cooldowns, which dominate on longer runs.
export function estimateJobSeconds(count, enrichLimit) {
  const pages = Math.ceil(count / SCRAPE_LIMITS.PAGE_SIZE);
  const avgPageDelay = (SCRAPE_LIMITS.PAGE_DELAY_MIN_MS + SCRAPE_LIMITS.PAGE_DELAY_MAX_MS) / 2;
  const avgPageRest = (SCRAPE_LIMITS.PAGE_COOLDOWN_MIN_MS + SCRAPE_LIMITS.PAGE_COOLDOWN_MAX_MS) / 2;
  const pageRests = Math.max(0, Math.floor(pages / SCRAPE_LIMITS.PAGE_COOLDOWN_EVERY));
  const followersMs = pages * avgPageDelay + pageRests * avgPageRest;

  const enrich = enrichLimit || 0;
  const avgEnrichDelay = (SCRAPE_LIMITS.ENRICH_DELAY_MIN_MS + SCRAPE_LIMITS.ENRICH_DELAY_MAX_MS) / 2;
  const avgEnrichRest = (SCRAPE_LIMITS.ENRICH_COOLDOWN_MIN_MS + SCRAPE_LIMITS.ENRICH_COOLDOWN_MAX_MS) / 2;
  const enrichBatches = Math.max(0, Math.ceil(enrich / SCRAPE_LIMITS.ENRICH_BATCH) - 1);
  const enrichMs = enrich * avgEnrichDelay + enrichBatches * avgEnrichRest;

  return Math.round((followersMs + enrichMs) / 1000);
}

function jobWithProgress(db, job) {
  if (!job) return null;
  const enrichable = db.prepare(
    'SELECT COUNT(*) as cnt FROM scrape_results WHERE job_id = ? AND enriched = 0'
  ).get(job.id).cnt;
  // Rows we marked enriched but got no usable data for. Tracked separately so
  // the UI can't show a reassuring "500/500 enriched" when every lookup was
  // refused by Instagram.
  const enrichedEmpty = db.prepare(`
    SELECT COUNT(*) as cnt FROM scrape_results
    WHERE job_id = ? AND enriched = 1 AND bio IS NULL AND follower_count IS NULL
  `).get(job.id).cnt;
  const totalTarget = job.requested_count || 0;
  const percent = totalTarget > 0
    ? Math.min(100, Math.round((job.scraped_count / totalTarget) * 100))
    : 0;
  return {
    ...job,
    percent,
    pending_enrich: enrichable,
    enriched_empty: enrichedEmpty,
    enriched_with_data: Math.max(0, (job.enriched_count || 0) - enrichedEmpty),
    estimated_total_seconds: estimateJobSeconds(job.requested_count, job.enrich_limit),
  };
}

// ---------------------------------------------------------------------------
// Web UI endpoints
// ---------------------------------------------------------------------------

router.get('/limits', (req, res) => {
  res.json({
    limits: SCRAPE_LIMITS,
    budget: budgetState(req.db),
  });
});

router.post('/estimate', (req, res) => {
  const count = Number(req.body?.count) || 0;
  const enrichLimit = Number(req.body?.enrich_limit) || 0;
  const pages = Math.ceil(count / SCRAPE_LIMITS.PAGE_SIZE);
  res.json({
    requests_needed: pages + enrichLimit,
    estimated_seconds: estimateJobSeconds(count, enrichLimit),
    budget: budgetState(req.db),
  });
});

router.get('/jobs', (req, res) => {
  const db = req.db;
  const jobs = db.prepare('SELECT * FROM scrape_jobs ORDER BY id DESC LIMIT 50').all();
  res.json({
    jobs: jobs.map(j => jobWithProgress(db, j)),
    budget: budgetState(db),
  });
});

router.get('/jobs/:id', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  const sample = db.prepare(
    'SELECT username, full_name, bio, follower_count, is_private, enriched FROM scrape_results WHERE job_id = ? ORDER BY id ASC LIMIT 25'
  ).all(job.id);
  res.json({ job: jobWithProgress(db, job), sample });
});

// Accepts a bare username, an @handle, or any instagram.com profile URL.
export function parseTargetUsername(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  const urlMatch = s.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  if (urlMatch) {
    s = urlMatch[1];
  } else {
    s = s.replace(/^@/, '');
  }
  s = s.split(/[/?#]/)[0].trim().toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(s)) return null;
  // Instagram reserved paths that are never real profiles.
  const reserved = new Set(['explore', 'reels', 'direct', 'stories', 'accounts', 'p', 'reel', 'tv', 'about', 'legal', 'developer']);
  if (reserved.has(s)) return null;
  return s;
}

router.post('/jobs', (req, res) => {
  const db = req.db;
  const { target, count, enrich_limit } = req.body || {};

  const username = parseTargetUsername(target);
  if (!username) {
    return res.status(400).json({ error: 'Укажите корректный @username или ссылку на профиль Instagram' });
  }

  const requested = Math.floor(Number(count));
  if (!Number.isFinite(requested) || requested < SCRAPE_LIMITS.MIN_REQUESTED_COUNT || requested > SCRAPE_LIMITS.MAX_REQUESTED_COUNT) {
    return res.status(400).json({
      error: `Количество должно быть от ${SCRAPE_LIMITS.MIN_REQUESTED_COUNT} до ${SCRAPE_LIMITS.MAX_REQUESTED_COUNT}`,
    });
  }

  let enrich = Math.floor(Number(enrich_limit) || 0);
  if (!Number.isFinite(enrich) || enrich < 0) enrich = 0;
  // Enriching more profiles than we scrape makes no sense.
  if (enrich > requested) enrich = requested;

  const active = db.prepare(
    `SELECT id FROM scrape_jobs WHERE status IN ('pending','running','paused')`
  ).get();
  if (active) {
    return res.status(409).json({
      error: `Уже есть активная задача #${active.id}. Дождитесь её завершения или отмените — параллельный скрейпинг сильно повышает риск блокировки.`,
    });
  }

  const result = db.prepare(`
    INSERT INTO scrape_jobs (target_username, requested_count, enrich_limit, status, phase, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 'resolve', ?, ?)
  `).run(username, requested, enrich, getMoscowISO(), getMoscowISO());

  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(result.lastInsertRowid);
  console.log(`[LeadFinder] Job #${job.id} created: @${username}, ${requested} followers, enrich ${enrich}`);
  res.json({ job: jobWithProgress(db, job), budget: budgetState(db) });
});

function setJobStatus(db, id, status, extra = {}) {
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(id);
  if (!job) return null;
  const finished = ['completed', 'failed', 'cancelled'].includes(status);
  db.prepare(`
    UPDATE scrape_jobs
    SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?,
        finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
    WHERE id = ?
  `).run(status, extra.error_message ?? null, getMoscowISO(), finished ? 1 : 0, getMoscowISO(), id);
  return db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(id);
}

router.post('/jobs/:id/pause', (req, res) => {
  const job = setJobStatus(req.db, req.params.id, 'paused');
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json({ job: jobWithProgress(req.db, job) });
});

router.post('/jobs/:id/resume', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  if (!['paused', 'failed'].includes(job.status)) {
    return res.status(400).json({ error: `Нельзя возобновить задачу в статусе "${job.status}"` });
  }
  db.prepare(`
    UPDATE scrape_jobs SET status = 'running', consecutive_errors = 0, error_message = NULL, updated_at = ? WHERE id = ?
  `).run(getMoscowISO(), job.id);
  res.json({ job: jobWithProgress(db, db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(job.id)) });
});

router.post('/jobs/:id/cancel', (req, res) => {
  const job = setJobStatus(req.db, req.params.id, 'cancelled');
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json({ job: jobWithProgress(req.db, job) });
});

router.delete('/jobs/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM scrape_results WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM scrape_jobs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/jobs/:id/export.csv', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const rows = db.prepare(`
    SELECT username, full_name, bio, follower_count, following_count, post_count,
           external_url, is_private, is_verified, ig_user_id, enriched
    FROM scrape_results WHERE job_id = ? ORDER BY id ASC
  `).all(job.id);

  const headers = [
    'username', 'full_name', 'bio', 'followers', 'following', 'posts',
    'external_url', 'is_private', 'is_verified', 'profile_url', 'ig_user_id', 'enriched',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.username),
      csvCell(r.full_name),
      csvCell((r.bio || '').replace(/\r?\n/g, ' ')),
      csvCell(r.follower_count),
      csvCell(r.following_count),
      csvCell(r.post_count),
      csvCell(r.external_url),
      csvCell(r.is_private ? 'yes' : 'no'),
      csvCell(r.is_verified ? 'yes' : 'no'),
      csvCell(`https://www.instagram.com/${r.username}/`),
      csvCell(r.ig_user_id),
      csvCell(r.enriched ? 'yes' : 'no'),
    ].join(','));
  }

  // UTF-8 BOM so Excel opens Cyrillic bios correctly instead of mojibake.
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const filename = `followers_${job.target_username}_${job.id}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// Scrape results deliberately have no path into the Contacts table. CSV export
// above is the only output — scraped usernames are raw prospects, not vetted
// contacts, and mixing them into the CRM automatically would pollute campaign
// audiences. Import the CSV through Contacts' own import screen if wanted.

// ---------------------------------------------------------------------------
// Extension-facing endpoints
//
// The extension never decides pacing or volume on its own — it asks for the
// next task and the response carries both the work and the delay to observe
// before doing it.
// ---------------------------------------------------------------------------

function reclaimStaleJobs(db) {
  // A job left 'running' by an extension that closed mid-flight would block
  // new jobs forever. Put it back to paused so the user can resume it.
  db.prepare(`
    UPDATE scrape_jobs
    SET status = 'paused', error_message = 'Расширение отключилось — задача приостановлена, можно продолжить'
    WHERE status = 'running'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < datetime(?, '-${SCRAPE_LIMITS.STALE_JOB_MINUTES} minutes')
  `).run(getMoscowISO());
}

export function getScrapeTask(db) {
  reclaimStaleJobs(db);

  const job = db.prepare(
    `SELECT * FROM scrape_jobs WHERE status IN ('pending','running') ORDER BY id ASC LIMIT 1`
  ).get();
  if (!job) return { task: null };

  const budget = budgetState(db);
  if (budget.remaining <= 0) {
    return {
      task: null,
      message: `Дневной бюджет запросов исчерпан (${budget.used}/${budget.limit}). Скрейпинг продолжится завтра.`,
    };
  }

  if (job.status === 'pending') {
    db.prepare(`UPDATE scrape_jobs SET status = 'running', updated_at = ?, last_progress_at = ? WHERE id = ?`)
      .run(getMoscowISO(), getMoscowISO(), job.id);
  }

  // Phase 1: resolve the target's numeric id (needed by the followers endpoint).
  if (!job.target_user_id) {
    return {
      task: {
        type: 'resolve_target',
        job_id: job.id,
        username: job.target_username,
        delay_ms: 0,
      },
      budget,
    };
  }

  // Phase 2: page through the follower list.
  if (job.scraped_count < job.requested_count && job.phase !== 'enrich') {
    const remaining = job.requested_count - job.scraped_count;
    // Pages already completed decides whether the next one starts a fresh
    // burst or continues the current one.
    const pagesDone = Math.floor(job.scraped_count / SCRAPE_LIMITS.PAGE_SIZE);
    const dueForRest = pagesDone > 0 && pagesDone % SCRAPE_LIMITS.PAGE_COOLDOWN_EVERY === 0;
    return {
      task: {
        type: 'fetch_followers',
        job_id: job.id,
        user_id: job.target_user_id,
        username: job.target_username,
        cursor: job.next_cursor || null,
        page_size: Math.min(SCRAPE_LIMITS.PAGE_SIZE, remaining),
        delay_ms: dueForRest
          ? randBetween(SCRAPE_LIMITS.PAGE_COOLDOWN_MIN_MS, SCRAPE_LIMITS.PAGE_COOLDOWN_MAX_MS)
          : randBetween(SCRAPE_LIMITS.PAGE_DELAY_MIN_MS, SCRAPE_LIMITS.PAGE_DELAY_MAX_MS),
        resting: dueForRest,
        progress: { scraped: job.scraped_count, target: job.requested_count },
      },
      budget,
    };
  }

  // Phase 3: optional profile enrichment (bio / follower counts).
  if (job.enrich_limit > 0 && job.enriched_count < job.enrich_limit) {
    const batchSize = Math.min(
      SCRAPE_LIMITS.ENRICH_BATCH,
      job.enrich_limit - job.enriched_count,
      budget.remaining
    );
    const targets = db.prepare(`
      SELECT username FROM scrape_results
      WHERE job_id = ? AND enriched = 0
      ORDER BY id ASC LIMIT ?
    `).all(job.id, batchSize).map(r => r.username);

    if (targets.length > 0) {
      if (job.phase !== 'enrich') {
        db.prepare(`UPDATE scrape_jobs SET phase = 'enrich', updated_at = ? WHERE id = ?`)
          .run(getMoscowISO(), job.id);
      }
      // Rest between batches, not just between individual lookups.
      const isFirstBatch = job.enriched_count === 0;
      return {
        task: {
          type: 'enrich_profiles',
          job_id: job.id,
          usernames: targets,
          delay_min_ms: SCRAPE_LIMITS.ENRICH_DELAY_MIN_MS,
          delay_max_ms: SCRAPE_LIMITS.ENRICH_DELAY_MAX_MS,
          delay_ms: isFirstBatch
            ? randBetween(SCRAPE_LIMITS.ENRICH_DELAY_MIN_MS, SCRAPE_LIMITS.ENRICH_DELAY_MAX_MS)
            : randBetween(SCRAPE_LIMITS.ENRICH_COOLDOWN_MIN_MS, SCRAPE_LIMITS.ENRICH_COOLDOWN_MAX_MS),
          resting: !isFirstBatch,
          progress: { enriched: job.enriched_count, target: job.enrich_limit },
        },
        budget,
      };
    }
  }

  // Nothing left to do.
  db.prepare(`
    UPDATE scrape_jobs SET status = 'completed', phase = 'done', updated_at = ?, finished_at = ? WHERE id = ?
  `).run(getMoscowISO(), getMoscowISO(), job.id);
  console.log(`[LeadFinder] Job #${job.id} completed: ${job.scraped_count} scraped, ${job.enriched_count} enriched`);
  return { task: null, message: `Задача #${job.id} завершена` };
}

router.get('/task', (req, res) => {
  try {
    res.json(getScrapeTask(req.db));
  } catch (e) {
    console.error('[LeadFinder] task error:', e.message);
    res.status(500).json({ task: null, error: e.message });
  }
});

router.post('/task/:id/resolved', (req, res) => {
  const db = req.db;
  const { user_id, follower_total } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  db.prepare(`
    UPDATE scrape_jobs
    SET target_user_id = ?, target_follower_total = ?, phase = 'followers',
        consecutive_errors = 0, updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(String(user_id), Number(follower_total) || null, getMoscowISO(), getMoscowISO(), req.params.id);
  spendBudget(db, 1);

  res.json({ success: true });
});

router.post('/task/:id/followers', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { users, next_cursor, exhausted } = req.body || {};
  const list = Array.isArray(users) ? users : [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO scrape_results
      (job_id, username, full_name, ig_user_id, is_private, is_verified, profile_pic_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  const room = Math.max(0, job.requested_count - job.scraped_count);
  const tx = db.transaction(() => {
    for (const u of list) {
      if (added >= room) break;
      const uname = String(u?.username || '').trim().toLowerCase();
      if (!uname) continue;
      const r = insert.run(
        job.id,
        uname,
        u.full_name || null,
        u.pk ? String(u.pk) : null,
        u.is_private ? 1 : 0,
        u.is_verified ? 1 : 0,
        u.profile_pic_url || null,
        getMoscowISO()
      );
      if (r.changes > 0) added++;
    }
  });
  tx();

  const total = db.prepare('SELECT COUNT(*) as cnt FROM scrape_results WHERE job_id = ?').get(job.id).cnt;
  const done = exhausted || !next_cursor || total >= job.requested_count;

  db.prepare(`
    UPDATE scrape_jobs
    SET scraped_count = ?, next_cursor = ?, consecutive_errors = 0,
        phase = CASE WHEN ? = 1 THEN 'enrich' ELSE 'followers' END,
        updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(total, done ? null : String(next_cursor), done ? 1 : 0, getMoscowISO(), getMoscowISO(), job.id);
  spendBudget(db, 1);

  // The follower list ran dry before reaching the requested count — that's a
  // normal outcome for accounts with fewer followers than asked for.
  if (done && total < job.requested_count) {
    console.log(`[LeadFinder] Job #${job.id}: follower list exhausted at ${total}/${job.requested_count}`);
  }

  res.json({ success: true, added, total, done });
});

router.post('/task/:id/enriched', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { profiles } = req.body || {};
  const list = Array.isArray(profiles) ? profiles : [];

  const update = db.prepare(`
    UPDATE scrape_results
    SET bio = ?, follower_count = ?, following_count = ?, post_count = ?,
        external_url = ?, full_name = COALESCE(NULLIF(?, ''), full_name),
        ig_user_id = COALESCE(ig_user_id, ?), enriched = 1
    WHERE job_id = ? AND username = ?
  `);
  // A profile we could not read (deleted, private-blocked, error) is still
  // marked enriched so the job doesn't retry it forever.
  const markFailed = db.prepare(
    `UPDATE scrape_results SET enriched = 1 WHERE job_id = ? AND username = ?`
  );

  let ok = 0;
  let failed = 0;
  const tx = db.transaction(() => {
    for (const p of list) {
      const uname = String(p?.username || '').trim().toLowerCase();
      if (!uname) continue;
      // A profile counts as read if we got either a bio or a numeric follower
      // count. A legitimately empty bio with 0 followers still qualifies —
      // follower_count 0 is finite. Only a genuinely empty response fails.
      const hasData = !!(p.bio && String(p.bio).length > 0) || Number.isFinite(Number(p.follower_count));
      if (p.error || !hasData) {
        markFailed.run(job.id, uname);
        failed++;
        continue;
      }
      update.run(
        p.bio || null,
        Number.isFinite(Number(p.follower_count)) ? Number(p.follower_count) : null,
        Number.isFinite(Number(p.following_count)) ? Number(p.following_count) : null,
        Number.isFinite(Number(p.post_count)) ? Number(p.post_count) : null,
        p.external_url || null,
        p.full_name || '',
        p.user_id ? String(p.user_id) : null,
        job.id,
        uname
      );
      ok++;
    }
  });
  tx();

  const enriched = db.prepare(
    'SELECT COUNT(*) as cnt FROM scrape_results WHERE job_id = ? AND enriched = 1'
  ).get(job.id).cnt;

  db.prepare(`
    UPDATE scrape_jobs SET enriched_count = ?, consecutive_errors = 0, updated_at = ?, last_progress_at = ? WHERE id = ?
  `).run(enriched, getMoscowISO(), getMoscowISO(), job.id);
  spendBudget(db, list.length);

  res.json({ success: true, ok, failed, enriched });
});

router.post('/task/:id/error', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { error_message, fatal, rate_limited } = req.body || {};
  const errors = (job.consecutive_errors || 0) + 1;

  // Any block signal or rate limit stops the job immediately — this is the
  // same posture as campaign sending. Grinding on through a 429 is what
  // turns a temporary limit into a lasting one.
  const shouldPause = false;

  let humanError = null;

  db.prepare(`
    UPDATE scrape_jobs
    SET consecutive_errors = ?, error_message = ?, status = CASE WHEN ? = 1 THEN 'paused' ELSE status END,
        updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(errors, humanError, shouldPause ? 1 : 0, getMoscowISO(), getMoscowISO(), job.id);

  if (humanError) {
    console.log(`[LeadFinder] Job #${job.id}: ${humanError}`);
  }

  res.json({ success: true, paused: shouldPause, consecutive_errors: errors });
});

export default router;
