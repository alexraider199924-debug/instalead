import { Router } from 'express';
import * as XLSX from 'xlsx';
import { getMoscowISO } from '../services/schedulerService.js';
import { getDailyBudget, getBudgetUsedToday, spendBudget } from './lead-finder.js';
import {
  buildSearchPlan,
  normalizePlan,
  planSourceCount,
  prefilterCandidate,
  scoreCandidates,
  isMatch,
  SCORE_BATCH,
} from '../services/leadSearchService.js';
import { notify, notifyDocument, escHtml } from '../services/notifier.js';

const router = Router();

// ---------------------------------------------------------------------------
// Pacing.
//
// Same posture as SCRAPE_LIMITS in lead-finder.js: the server decides the
// delay and sends it with the task, so pacing can't be shortened by editing
// extension code. Search endpoints are read-only surfaces a logged-in user
// hits constantly by hand, so the per-request risk is low — total daily volume
// is what matters, and that is capped by the shared ig_request_budget.
// ---------------------------------------------------------------------------
export const SEARCH_LIMITS = {
  // Discovery: one request returns a page of accounts or posts.
  DISCOVER_DELAY_MIN_MS: 4000,
  DISCOVER_DELAY_MAX_MS: 9000,
  DISCOVER_COOLDOWN_EVERY: 6,
  DISCOVER_COOLDOWN_MIN_MS: 25000,
  DISCOVER_COOLDOWN_MAX_MS: 50000,
  // How many pages we are willing to pull from a single hashtag or place
  // before moving on. Deep pages of one tag drift off-topic fast; breadth
  // across sources beats depth in one.
  MAX_PAGES_PER_SOURCE: 6,
  // Enrichment: one request per profile, the expensive phase.
  ENRICH_DELAY_MIN_MS: 1000,
  ENRICH_DELAY_MAX_MS: 2500,
  ENRICH_BATCH: 5,
  ENRICH_COOLDOWN_MIN_MS: 15000,
  ENRICH_COOLDOWN_MAX_MS: 30000,
  // Job-level caps.
  MAX_TARGET_COUNT: 600,
  MIN_TARGET_COUNT: 10,
  MAX_ENRICH_LIMIT: 300,
  // Consecutive failed rounds before the job pauses itself.
  MAX_CONSECUTIVE_ERRORS: 3,
  STALE_JOB_MINUTES: 15,
  // A lead has to clear this to land in the exported table.
  DEFAULT_MIN_SCORE: 60,
};

function randBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function budgetState(db) {
  const limit = getDailyBudget(db);
  const used = getBudgetUsedToday(db);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

function readPlan(job) {
  try {
    return normalizePlan(JSON.parse(job.plan_json));
  } catch (e) {
    return normalizePlan({});
  }
}

// Discovery pages are cheap and return many accounts each; enrichment is one
// request per profile. Estimating them separately keeps the UI warning honest
// on jobs that are mostly one or mostly the other.
export function estimateSearchRequests(sourceCount, targetCount, enrichLimit) {
  const pagesPerSource = Math.min(
    SEARCH_LIMITS.MAX_PAGES_PER_SOURCE,
    Math.max(1, Math.ceil(targetCount / Math.max(1, sourceCount) / 20))
  );
  const discoverRequests = sourceCount * pagesPerSource;
  return { discoverRequests, enrichRequests: enrichLimit, total: discoverRequests + enrichLimit };
}

export function estimateSearchSeconds(sourceCount, targetCount, enrichLimit) {
  const { discoverRequests } = estimateSearchRequests(sourceCount, targetCount, enrichLimit);

  const avgDiscover = (SEARCH_LIMITS.DISCOVER_DELAY_MIN_MS + SEARCH_LIMITS.DISCOVER_DELAY_MAX_MS) / 2;
  const avgDiscoverRest = (SEARCH_LIMITS.DISCOVER_COOLDOWN_MIN_MS + SEARCH_LIMITS.DISCOVER_COOLDOWN_MAX_MS) / 2;
  const discoverRests = Math.floor(discoverRequests / SEARCH_LIMITS.DISCOVER_COOLDOWN_EVERY);
  const discoverMs = discoverRequests * avgDiscover + discoverRests * avgDiscoverRest;

  const avgEnrich = (SEARCH_LIMITS.ENRICH_DELAY_MIN_MS + SEARCH_LIMITS.ENRICH_DELAY_MAX_MS) / 2;
  const avgEnrichRest = (SEARCH_LIMITS.ENRICH_COOLDOWN_MIN_MS + SEARCH_LIMITS.ENRICH_COOLDOWN_MAX_MS) / 2;
  const enrichRests = Math.max(0, Math.ceil(enrichLimit / SEARCH_LIMITS.ENRICH_BATCH) - 1);
  const enrichMs = enrichLimit * avgEnrich + enrichRests * avgEnrichRest;

  return Math.round((discoverMs + enrichMs) / 1000);
}

export function jobWithProgress(db, job) {
  if (!job) return null;
  const sources = db.prepare(
    'SELECT id, kind, value, ig_id, page, found_count, exhausted, error_message FROM lead_search_sources WHERE job_id = ? ORDER BY id ASC'
  ).all(job.id);

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS discovered,
      SUM(CASE WHEN prefiltered = 1 THEN 1 ELSE 0 END) AS filtered_out,
      SUM(CASE WHEN prefiltered = 0 AND enriched = 0 THEN 1 ELSE 0 END) AS pending_enrich,
      SUM(CASE WHEN enriched = 1 AND scored = 0 THEN 1 ELSE 0 END) AS pending_score
    FROM lead_search_results WHERE job_id = ?
  `).get(job.id);

  const percent = job.target_count > 0
    ? Math.min(100, Math.round((job.discovered_count / job.target_count) * 100))
    : 0;

  return {
    ...job,
    plan: readPlan(job),
    sources,
    percent,
    filtered_out: counts?.filtered_out || 0,
    pending_enrich: counts?.pending_enrich || 0,
    pending_score: counts?.pending_score || 0,
    estimated_total_seconds: estimateSearchSeconds(sources.length, job.target_count, job.enrich_limit),
  };
}

function setStatus(db, id, status, extra = {}) {
  const finished = ['completed', 'failed', 'cancelled'].includes(status);
  db.prepare(`
    UPDATE lead_search_jobs
    SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?,
        finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
    WHERE id = ?
  `).run(status, extra.error_message ?? null, getMoscowISO(), finished ? 1 : 0, getMoscowISO(), id);
  return db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Web UI endpoints
// ---------------------------------------------------------------------------

router.get('/limits', (req, res) => {
  res.json({ limits: SEARCH_LIMITS, budget: budgetState(req.db) });
});

// Plan preview. Deliberately a separate call from job creation: the plan is
// meant to be reviewed and edited before a single Instagram request is spent.
router.post('/plan', async (req, res) => {
  try {
    const plan = await buildSearchPlan(req.db, req.body?.query);
    const sources = planSourceCount(plan);
    res.json({
      plan,
      source_count: sources,
      estimate: {
        ...estimateSearchRequests(sources, 200, 100),
        estimated_seconds: estimateSearchSeconds(sources, 200, 100),
      },
      budget: budgetState(req.db),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/estimate', (req, res) => {
  const plan = normalizePlan(req.body?.plan);
  const sources = planSourceCount(plan);
  const target = Number(req.body?.target_count) || 200;
  const enrich = Number(req.body?.enrich_limit) || 0;
  res.json({
    source_count: sources,
    ...estimateSearchRequests(sources, target, enrich),
    estimated_seconds: estimateSearchSeconds(sources, target, enrich),
    budget: budgetState(req.db),
  });
});

router.get('/jobs', (req, res) => {
  const db = req.db;
  const jobs = db.prepare('SELECT * FROM lead_search_jobs ORDER BY id DESC LIMIT 50').all();
  res.json({ jobs: jobs.map(j => jobWithProgress(db, j)), budget: budgetState(db) });
});

router.get('/jobs/:id', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { sort, only_matched } = req.query;
  const matchedFilter = only_matched === '1' ? 'AND matched = 1' : '';
  const orderBy = sort === 'followers'
    ? 'follower_count DESC NULLS LAST'
    : 'matched DESC, ai_score DESC NULLS LAST, id ASC';

  const results = db.prepare(`
    SELECT id, username, full_name, bio, follower_count, following_count, post_count,
           external_url, is_private, is_verified, source_kind, source_value, post_location,
           enriched, scored, ai_score, ai_geo, ai_geo_confidence, ai_reason, matched
    FROM lead_search_results
    WHERE job_id = ? AND prefiltered = 0 ${matchedFilter}
    ORDER BY ${orderBy}
    LIMIT 500
  `).all(job.id);

  res.json({ job: jobWithProgress(db, job), results, budget: budgetState(db) });
});

// Job creation lives outside the route handler because the Telegram bot
// creates jobs too, and it calls services in-process rather than looping back
// through this API — it has no session to authenticate with.
export function createSearchJob(db, { query, plan: rawPlan, target_count, enrich_limit, min_score }) {
  const queryText = String(query || '').trim();
  if (!queryText) throw Object.assign(new Error('Укажите запрос'), { status: 400 });

  const plan = normalizePlan(rawPlan);
  const sourceCount = planSourceCount(plan);
  if (sourceCount === 0) {
    throw Object.assign(
      new Error('В плане нет ни одного источника — добавьте хештег, ключевое слово или место'),
      { status: 400 }
    );
  }

  const target = Math.floor(Number(target_count));
  if (!Number.isFinite(target) || target < SEARCH_LIMITS.MIN_TARGET_COUNT || target > SEARCH_LIMITS.MAX_TARGET_COUNT) {
    throw Object.assign(
      new Error(`Сколько кандидатов собрать — от ${SEARCH_LIMITS.MIN_TARGET_COUNT} до ${SEARCH_LIMITS.MAX_TARGET_COUNT}`),
      { status: 400 }
    );
  }

  let enrich = Math.floor(Number(enrich_limit) || 0);
  if (!Number.isFinite(enrich) || enrich < 0) enrich = 0;
  if (enrich > SEARCH_LIMITS.MAX_ENRICH_LIMIT) enrich = SEARCH_LIMITS.MAX_ENRICH_LIMIT;
  if (enrich > target) enrich = target;

  // One Instagram job at a time across both engines — see getSearchTask.
  const busySearch = db.prepare(
    `SELECT id FROM lead_search_jobs WHERE status IN ('pending','running','paused')`
  ).get();
  if (busySearch) {
    throw Object.assign(
      new Error(`Уже есть активный поиск #${busySearch.id}. Дождитесь завершения или отмените его.`),
      { status: 409 }
    );
  }
  const busyScrape = db.prepare(
    `SELECT id FROM scrape_jobs WHERE status IN ('pending','running','paused')`
  ).get();
  if (busyScrape) {
    throw Object.assign(
      new Error(`Активна задача Lead Finder #${busyScrape.id}. Параллельная работа с Instagram сильно повышает риск блокировки.`),
      { status: 409 }
    );
  }

  const result = db.prepare(`
    INSERT INTO lead_search_jobs (query_text, plan_json, target_count, enrich_limit, status, phase, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 'discover', ?, ?)
  `).run(queryText, JSON.stringify(plan), target, enrich, getMoscowISO(), getMoscowISO());

  const jobId = result.lastInsertRowid;

  const insertSource = db.prepare(
    'INSERT OR IGNORE INTO lead_search_sources (job_id, kind, value) VALUES (?, ?, ?)'
  );
  db.transaction(() => {
    // Narrow sources first: hashtags and places carry the niche and the geo,
    // keyword search is the broadest and therefore the noisiest.
    for (const tag of plan.hashtags) insertSource.run(jobId, 'hashtag', tag);
    for (const place of plan.places) insertSource.run(jobId, 'place', place);
    for (const kw of plan.keywords) insertSource.run(jobId, 'keyword', kw);
  })();

  const minScore = Number(min_score);
  if (Number.isFinite(minScore) && minScore >= 0 && minScore <= 100) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('lead_search_min_score', ?)`)
      .run(String(Math.round(minScore)));
  }

  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(jobId);
  console.log(`[LeadSearch] Job #${jobId} created: "${queryText}" — ${sourceCount} sources, target ${target}, enrich ${enrich}`);
  return jobWithProgress(db, job);
}

router.post('/jobs', (req, res) => {
  try {
    const job = createSearchJob(req.db, req.body || {});
    res.json({ job, budget: budgetState(req.db) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/jobs/:id/pause', (req, res) => {
  const job = setStatus(req.db, req.params.id, 'paused');
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json({ job: jobWithProgress(req.db, job) });
});

router.post('/jobs/:id/resume', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  if (!['paused', 'failed'].includes(job.status)) {
    return res.status(400).json({ error: `Нельзя возобновить задачу в статусе "${job.status}"` });
  }
  db.prepare(`
    UPDATE lead_search_jobs SET status = 'running', consecutive_errors = 0, error_message = NULL, updated_at = ? WHERE id = ?
  `).run(getMoscowISO(), job.id);
  res.json({ job: jobWithProgress(db, db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(job.id)) });
});

router.post('/jobs/:id/cancel', (req, res) => {
  const job = setStatus(req.db, req.params.id, 'cancelled');
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json({ job: jobWithProgress(req.db, job) });
});

router.delete('/jobs/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM lead_search_results WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lead_search_sources WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lead_search_jobs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_HEADERS = [
  'username', 'full_name', 'score', 'geo', 'geo_confidence', 'why',
  'bio', 'followers', 'following', 'posts', 'external_url',
  'source', 'source_value', 'post_location', 'is_private', 'is_verified', 'profile_url',
];

export function exportRows(db, jobId, onlyMatched = true) {
  const rows = db.prepare(`
    SELECT * FROM lead_search_results
    WHERE job_id = ? AND prefiltered = 0 ${onlyMatched ? 'AND matched = 1' : ''}
    ORDER BY matched DESC, ai_score DESC NULLS LAST, id ASC
  `).all(jobId);

  return rows.map(r => ({
    username: r.username,
    full_name: r.full_name || '',
    score: r.ai_score ?? '',
    geo: r.ai_geo || '',
    geo_confidence: r.ai_geo_confidence || '',
    why: r.ai_reason || '',
    bio: (r.bio || '').replace(/\r?\n/g, ' '),
    followers: r.follower_count ?? '',
    following: r.following_count ?? '',
    posts: r.post_count ?? '',
    external_url: r.external_url || '',
    source: r.source_kind || '',
    source_value: r.source_value || '',
    post_location: r.post_location || '',
    is_private: r.is_private ? 'yes' : 'no',
    is_verified: r.is_verified ? 'yes' : 'no',
    profile_url: `https://www.instagram.com/${r.username}/`,
  }));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/jobs/:id/export.csv', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const rows = exportRows(db, job.id, req.query.all !== '1');
  const lines = [EXPORT_HEADERS.join(',')];
  for (const r of rows) lines.push(EXPORT_HEADERS.map(h => csvCell(r[h])).join(','));

  // UTF-8 BOM so Excel opens Cyrillic bios correctly instead of mojibake.
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads_search_${job.id}.csv"`);
  res.send(csv);
});

export function buildXlsx(db, jobId, onlyMatched = true) {
  const rows = exportRows(db, jobId, onlyMatched);
  const sheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS });
  sheet['!cols'] = [
    { wch: 22 }, { wch: 24 }, { wch: 7 }, { wch: 16 }, { wch: 14 }, { wch: 34 },
    { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 28 },
    { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 36 },
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Leads');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

router.get('/jobs/:id/export.xlsx', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const buffer = buildXlsx(db, job.id, req.query.all !== '1');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads_search_${job.id}.xlsx"`);
  res.send(buffer);
});

// Unlike raw follower scrapes, search results are already AI-vetted against an
// explicit brief, so promoting the matched ones into Contacts is a deliberate
// action the user takes — not an automatic side effect of the job finishing.
router.post('/jobs/:id/to-contacts', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const ids = Array.isArray(req.body?.result_ids) ? req.body.result_ids : null;
  const all = req.query.all === '1';
  const rows = ids?.length
    ? db.prepare(`SELECT * FROM lead_search_results WHERE job_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .all(job.id, ...ids)
    : all
      ? db.prepare('SELECT * FROM lead_search_results WHERE job_id = ? AND prefiltered = 0').all(job.id)
      : db.prepare('SELECT * FROM lead_search_results WHERE job_id = ? AND matched = 1').all(job.id);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO contacts (username, full_name, details, notes, lead_quality)
    VALUES (?, ?, ?, ?, ?)
  `);

  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      const notes = [
        r.ai_reason ? `AI: ${r.ai_reason}` : null,
        r.ai_geo ? `Гео: ${r.ai_geo} (${r.ai_geo_confidence})` : null,
        `Найден: ${r.source_kind} "${r.source_value}"`,
        `Запрос: ${job.query_text}`,
      ].filter(Boolean).join('\n');
      const quality = (r.ai_score ?? 0) >= 80 ? 'hot' : (r.ai_score ?? 0) >= 60 ? 'warm' : 'unknown';
      const out = insert.run(r.username, r.full_name || null, r.bio || null, notes, quality);
      if (out.changes > 0) added++;
    }
  })();

  res.json({ success: true, added, total: rows.length });
});

// ---------------------------------------------------------------------------
// Scoring
//
// Runs on the server between extension round-trips. Kept out of the extension
// entirely: it needs the OpenRouter key, which never leaves the backend.
// ---------------------------------------------------------------------------

function getMinScore(db) {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'lead_search_min_score'`).get();
    const n = Number(row?.value);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  } catch (e) {}
  return SEARCH_LIMITS.DEFAULT_MIN_SCORE;
}

export async function runScoringPass(db, job, maxBatches = 1) {
  const plan = readPlan(job);
  const minScore = getMinScore(db);
  let scoredTotal = 0;

  for (let i = 0; i < maxBatches; i++) {
    const pending = db.prepare(`
      SELECT * FROM lead_search_results
      WHERE job_id = ? AND prefiltered = 0 AND enriched = 1 AND scored = 0
      ORDER BY id ASC LIMIT ?
    `).all(job.id, SCORE_BATCH);
    if (pending.length === 0) break;

    const scores = await scoreCandidates(db, plan, pending);

    const update = db.prepare(`
      UPDATE lead_search_results
      SET scored = 1, ai_score = ?, ai_geo = ?, ai_geo_confidence = ?, ai_reason = ?, matched = ?
      WHERE id = ?
    `);

    db.transaction(() => {
      for (const row of pending) {
        const s = scores.get(row.username);
        // A profile the model skipped stays scored = 0 so the next pass retries
        // it, rather than being silently written off as a zero.
        if (!s) continue;
        const matched = isMatch(plan, { ...row, ai_score: s.score }, minScore) ? 1 : 0;
        update.run(s.score, s.geo, s.geo_confidence, s.reason, matched, row.id);
        scoredTotal++;
      }
    })();

    // Every profile in the batch was skipped — retrying immediately would just
    // burn credits on the same failure.
    if (scoredTotal === 0) break;
  }

  if (scoredTotal > 0) {
    const totals = db.prepare(`
      SELECT SUM(scored) AS scored, SUM(matched) AS matched
      FROM lead_search_results WHERE job_id = ?
    `).get(job.id);
    db.prepare(`
      UPDATE lead_search_jobs SET scored_count = ?, matched_count = ?, updated_at = ? WHERE id = ?
    `).run(totals?.scored || 0, totals?.matched || 0, getMoscowISO(), job.id);
  }

  return scoredTotal;
}

// ---------------------------------------------------------------------------
// Extension-facing endpoints
// ---------------------------------------------------------------------------

function reclaimStaleJobs(db) {
  db.prepare(`
    UPDATE lead_search_jobs
    SET status = 'paused', error_message = 'Расширение отключилось — поиск приостановлен, можно продолжить'
    WHERE status = 'running'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < datetime(?, '-${SEARCH_LIMITS.STALE_JOB_MINUTES} minutes')
  `).run(getMoscowISO());
}

function discoverDelay(db, job) {
  // Pages completed across all sources — the actual request count for this
  // phase. Deriving it from discovered_count would be wrong: a page can return
  // 40 accounts or 3, and a job that has found little would rest constantly.
  const pages = db.prepare(
    'SELECT COALESCE(SUM(page), 0) AS pages FROM lead_search_sources WHERE job_id = ?'
  ).get(job.id).pages;
  const dueForRest = pages > 0 && pages % SEARCH_LIMITS.DISCOVER_COOLDOWN_EVERY === 0;
  return {
    delay_ms: dueForRest
      ? randBetween(SEARCH_LIMITS.DISCOVER_COOLDOWN_MIN_MS, SEARCH_LIMITS.DISCOVER_COOLDOWN_MAX_MS)
      : randBetween(SEARCH_LIMITS.DISCOVER_DELAY_MIN_MS, SEARCH_LIMITS.DISCOVER_DELAY_MAX_MS),
    resting: dueForRest,
  };
}

export async function getSearchTask(db) {
  reclaimStaleJobs(db);

  // Lead Finder owns Instagram whenever it has work — one engine at a time.
  const activeScrape = db.prepare(
    `SELECT id FROM scrape_jobs WHERE status IN ('pending','running')`
  ).get();
  if (activeScrape) return { task: null };

  const job = db.prepare(
    `SELECT * FROM lead_search_jobs WHERE status IN ('pending','running') ORDER BY id ASC LIMIT 1`
  ).get();
  if (!job) return { task: null };

  const budget = budgetState(db);
  if (budget.remaining <= 0) {
    return {
      task: null,
      message: `Дневной бюджет запросов исчерпан (${budget.used}/${budget.limit}). Поиск продолжится завтра.`,
    };
  }

  if (job.status === 'pending') {
    db.prepare(`UPDATE lead_search_jobs SET status = 'running', updated_at = ?, last_progress_at = ? WHERE id = ?`)
      .run(getMoscowISO(), getMoscowISO(), job.id);
  }

  // Phase 1: discovery, round-robin across sources so one rich hashtag can't
  // crowd out the geo-tagged places that carry confirmed location data.
  if (job.discovered_count < job.target_count) {
    const source = db.prepare(`
      SELECT * FROM lead_search_sources
      WHERE job_id = ? AND exhausted = 0 AND page < ?
      ORDER BY page ASC, id ASC LIMIT 1
    `).get(job.id, SEARCH_LIMITS.MAX_PAGES_PER_SOURCE);

    if (source) {
      const { delay_ms, resting } = discoverDelay(db, job);
      const base = {
        job_id: job.id,
        source_id: source.id,
        delay_ms,
        resting,
        progress: { discovered: job.discovered_count, target: job.target_count },
      };

      if (source.kind === 'place' && !source.ig_id) {
        return { task: { ...base, type: 'resolve_place', query: source.value }, budget };
      }
      if (source.kind === 'place') {
        return { task: { ...base, type: 'search_place', location_id: source.ig_id, place: source.value, cursor: source.cursor || null }, budget };
      }
      if (source.kind === 'hashtag') {
        return { task: { ...base, type: 'search_hashtag', tag: source.value, cursor: source.cursor || null }, budget };
      }
      return { task: { ...base, type: 'search_keyword', query: source.value }, budget };
    }
  }

  // Phase 2: enrich the candidates that survived the local pre-filter.
  if (job.enrich_limit > 0 && job.enriched_count < job.enrich_limit) {
    const batchSize = Math.min(
      SEARCH_LIMITS.ENRICH_BATCH,
      job.enrich_limit - job.enriched_count,
      budget.remaining
    );
    const targets = db.prepare(`
      SELECT username FROM lead_search_results
      WHERE job_id = ? AND prefiltered = 0 AND enriched = 0
      ORDER BY id ASC LIMIT ?
    `).all(job.id, batchSize).map(r => r.username);

    if (targets.length > 0) {
      if (job.phase !== 'enrich') {
        db.prepare(`UPDATE lead_search_jobs SET phase = 'enrich', updated_at = ? WHERE id = ?`)
          .run(getMoscowISO(), job.id);
      }
      const isFirstBatch = job.enriched_count === 0;
      return {
        task: {
          type: 'enrich_profiles',
          job_id: job.id,
          usernames: targets,
          delay_min_ms: SEARCH_LIMITS.ENRICH_DELAY_MIN_MS,
          delay_max_ms: SEARCH_LIMITS.ENRICH_DELAY_MAX_MS,
          delay_ms: isFirstBatch
            ? randBetween(SEARCH_LIMITS.ENRICH_DELAY_MIN_MS, SEARCH_LIMITS.ENRICH_DELAY_MAX_MS)
            : randBetween(SEARCH_LIMITS.ENRICH_COOLDOWN_MIN_MS, SEARCH_LIMITS.ENRICH_COOLDOWN_MAX_MS),
          resting: !isFirstBatch,
          progress: { enriched: job.enriched_count, target: job.enrich_limit },
        },
        budget,
      };
    }
  }

  // Phase 3: anything enriched but not yet scored. Scoring is server-side, so
  // there is no task to hand out — we do the work here and tell the extension
  // to come back. This doubles as the retry path when an OpenRouter call
  // failed inside the /enriched handler.
  const unscored = db.prepare(`
    SELECT COUNT(*) AS cnt FROM lead_search_results
    WHERE job_id = ? AND prefiltered = 0 AND enriched = 1 AND scored = 0
  `).get(job.id).cnt;

  if (unscored > 0) {
    if (job.phase !== 'score') {
      db.prepare(`UPDATE lead_search_jobs SET phase = 'score', updated_at = ? WHERE id = ?`)
        .run(getMoscowISO(), job.id);
    }
    let scored = 0;
    try {
      scored = await runScoringPass(db, job, 3);
    } catch (e) {
      console.error(`[LeadSearch] Job #${job.id} scoring failed:`, e.message);
      db.prepare(`UPDATE lead_search_jobs SET error_message = ?, updated_at = ? WHERE id = ?`)
        .run(`Оценка через AI не удалась: ${e.message}`, getMoscowISO(), job.id);
    }
    // Progress means come back for more; no progress means scoring is stuck
    // and holding the job open would spin forever, so we let it finish with
    // whatever was scored.
    if (scored > 0) {
      // retry tells the extension to poll again immediately: there is no
      // Instagram request involved, just more scoring to do.
      return { task: null, retry: true, message: `Оценка кандидатов: ${scored} обработано` };
    }
  }

  const final = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(job.id);
  db.prepare(`
    UPDATE lead_search_jobs SET status = 'completed', phase = 'done', updated_at = ?, finished_at = ? WHERE id = ?
  `).run(getMoscowISO(), getMoscowISO(), job.id);
  console.log(`[LeadSearch] Job #${job.id} completed: ${final.discovered_count} found, ${final.enriched_count} enriched, ${final.matched_count} matched`);

  // The whole point of running a search from Telegram: the table arrives in
  // the chat by itself. Detached from the response — a slow upload must not
  // hold up the extension's next poll.
  const caption =
    `✨ <b>Поиск #${job.id} завершён</b>\n\n<i>${escHtml(final.query_text)}</i>\n\n` +
    `Найдено: ${final.discovered_count} · разобрано: ${final.enriched_count} · ` +
    `подходят: <b>${final.matched_count}</b>`;

  if (final.matched_count > 0) {
    notifyDocument(
      db.workspaceName,
      () => buildXlsx(db, job.id, true),
      { filename: `instalead-leads-${job.id}.xlsx`, caption }
    ).catch(() => {});
  } else {
    notify(db.workspaceName, `${caption}\n\nПопробуйте смягчить порог или расширить план.`, {
      key: `search-done:${job.id}`,
    }).catch(() => {});
  }

  return { task: null, message: `Поиск #${job.id} завершён: ${final.matched_count} подходящих лидов`, job_completed: job.id };
}

router.get('/task', async (req, res) => {
  try {
    res.json(await getSearchTask(req.db));
  } catch (e) {
    console.error('[LeadSearch] task error:', e.message);
    res.status(500).json({ task: null, error: e.message });
  }
});

router.post('/task/:id/place-resolved', (req, res) => {
  const db = req.db;
  const { source_id, ig_id, name } = req.body || {};
  const source = db.prepare('SELECT * FROM lead_search_sources WHERE id = ? AND job_id = ?')
    .get(source_id, req.params.id);
  if (!source) return res.status(404).json({ error: 'Источник не найден' });

  if (!ig_id) {
    // No such place on Instagram — retire this source instead of retrying it
    // on every poll for the rest of the job.
    db.prepare(`UPDATE lead_search_sources SET exhausted = 1, error_message = 'Место не найдено в Instagram' WHERE id = ?`)
      .run(source.id);
  } else {
    db.prepare('UPDATE lead_search_sources SET ig_id = ?, value = COALESCE(NULLIF(?, \'\'), value) WHERE id = ?')
      .run(String(ig_id), name || '', source.id);
  }

  db.prepare('UPDATE lead_search_jobs SET consecutive_errors = 0, updated_at = ?, last_progress_at = ? WHERE id = ?')
    .run(getMoscowISO(), getMoscowISO(), req.params.id);
  spendBudget(db, 1);
  res.json({ success: true });
});

router.post('/task/:id/discovered', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { source_id, users, next_cursor, exhausted } = req.body || {};
  const source = db.prepare('SELECT * FROM lead_search_sources WHERE id = ? AND job_id = ?')
    .get(source_id, job.id);
  if (!source) return res.status(404).json({ error: 'Источник не найден' });

  const plan = readPlan(job);
  const list = Array.isArray(users) ? users : [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO lead_search_results
      (job_id, username, full_name, ig_user_id, is_private, is_verified,
       source_kind, source_value, post_caption, post_location, prefiltered, prefilter_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  let filtered = 0;
  const room = Math.max(0, job.target_count - job.discovered_count);

  db.transaction(() => {
    for (const u of list) {
      if (added >= room) break;
      const username = String(u?.username || '').trim().toLowerCase();
      if (!username) continue;

      const candidate = {
        username,
        full_name: u.full_name || null,
        post_caption: u.caption || null,
      };
      const verdict = prefilterCandidate(plan, candidate);

      // A post carries a real geotag only when the place source put it there.
      const postLocation = source.kind === 'place' ? source.value : (u.location || null);

      const out = insert.run(
        job.id,
        username,
        candidate.full_name,
        u.pk ? String(u.pk) : null,
        u.is_private ? 1 : 0,
        u.is_verified ? 1 : 0,
        source.kind,
        source.value,
        candidate.post_caption ? String(candidate.post_caption).slice(0, 500) : null,
        postLocation,
        verdict.keep ? 0 : 1,
        verdict.reason,
        getMoscowISO()
      );
      if (out.changes > 0) {
        added++;
        if (!verdict.keep) filtered++;
      }
    }
  })();

  const page = (source.page || 0) + 1;
  const sourceDone = exhausted || !next_cursor || page >= SEARCH_LIMITS.MAX_PAGES_PER_SOURCE;
  db.prepare(`
    UPDATE lead_search_sources
    SET page = ?, cursor = ?, found_count = found_count + ?, exhausted = ?
    WHERE id = ?
  `).run(page, sourceDone ? null : String(next_cursor), added, sourceDone ? 1 : 0, source.id);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM lead_search_results WHERE job_id = ?').get(job.id).cnt;
  db.prepare(`
    UPDATE lead_search_jobs
    SET discovered_count = ?, consecutive_errors = 0, updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(total, getMoscowISO(), getMoscowISO(), job.id);
  spendBudget(db, 1);

  res.json({ success: true, added, filtered_out: filtered, total, source_done: sourceDone });
});

router.post('/task/:id/enriched', async (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { profiles } = req.body || {};
  const list = Array.isArray(profiles) ? profiles : [];

  const update = db.prepare(`
    UPDATE lead_search_results
    SET bio = ?, follower_count = ?, following_count = ?, post_count = ?,
        external_url = ?, full_name = COALESCE(NULLIF(?, ''), full_name),
        ig_user_id = COALESCE(ig_user_id, ?), is_private = ?, is_verified = ?, enriched = 1
    WHERE job_id = ? AND username = ?
  `);
  // A profile we could not read is still marked enriched, and scored so the
  // scoring pass doesn't wait forever on data that will never arrive.
  const markFailed = db.prepare(
    `UPDATE lead_search_results SET enriched = 1, scored = 1, ai_score = 0, ai_reason = 'Профиль недоступен', matched = 0
     WHERE job_id = ? AND username = ?`
  );

  let ok = 0;
  let failed = 0;
  db.transaction(() => {
    for (const p of list) {
      const username = String(p?.username || '').trim().toLowerCase();
      if (!username) continue;
      const hasData = !!(p.bio && String(p.bio).length > 0) || Number.isFinite(Number(p.follower_count));
      if (p.error || !hasData) {
        markFailed.run(job.id, username);
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
        p.is_private ? 1 : 0,
        p.is_verified ? 1 : 0,
        job.id,
        username
      );
      ok++;
    }
  })();

  const enriched = db.prepare(
    'SELECT COUNT(*) AS cnt FROM lead_search_results WHERE job_id = ? AND enriched = 1'
  ).get(job.id).cnt;
  db.prepare(`
    UPDATE lead_search_jobs SET enriched_count = ?, consecutive_errors = 0, updated_at = ?, last_progress_at = ? WHERE id = ?
  `).run(enriched, getMoscowISO(), getMoscowISO(), job.id);
  spendBudget(db, list.length);

  // Score while the extension is resting between batches — by the time the job
  // finishes the table is already filled in. A failure here is not the
  // extension's problem: the batch is banked, and getSearchTask retries.
  let scored = 0;
  try {
    const fresh = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(job.id);
    scored = await runScoringPass(db, fresh, 5);
  } catch (e) {
    console.error(`[LeadSearch] Job #${job.id} inline scoring failed:`, e.message);
  }

  res.json({ success: true, ok, failed, enriched, scored });
});

router.post('/task/:id/error', (req, res) => {
  const db = req.db;
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });

  const { error_message, fatal, rate_limited, source_id } = req.body || {};

  // A single dead source must not take the whole job down — retire it and let
  // the other hashtags and places carry on. Only account-level signals
  // (429, checkpoint, spam) stop everything.
  if (source_id && !fatal && !rate_limited) {
    const source = db.prepare('SELECT * FROM lead_search_sources WHERE id = ? AND job_id = ?').get(source_id, job.id);
    if (source) {
      db.prepare('UPDATE lead_search_sources SET exhausted = 1, error_message = ? WHERE id = ?')
        .run(String(error_message || 'Источник недоступен').slice(0, 200), source.id);
      console.warn(`[LeadSearch] Job #${job.id}: source ${source.kind} "${source.value}" retired — ${error_message}`);

      const alive = db.prepare('SELECT COUNT(*) AS cnt FROM lead_search_sources WHERE job_id = ? AND exhausted = 0').get(job.id).cnt;
      if (alive > 0) {
        db.prepare('UPDATE lead_search_jobs SET updated_at = ?, last_progress_at = ? WHERE id = ?')
          .run(getMoscowISO(), getMoscowISO(), job.id);
        return res.json({ success: true, paused: false, source_retired: true, sources_left: alive });
      }
    }
  }

  const errors = (job.consecutive_errors || 0) + 1;
  const shouldPause = false;

  let humanError = null;

  db.prepare(`
    UPDATE lead_search_jobs
    SET consecutive_errors = ?, error_message = ?, status = CASE WHEN ? = 1 THEN 'paused' ELSE status END,
        updated_at = ?, last_progress_at = ?
    WHERE id = ?
  `).run(errors, humanError, shouldPause ? 1 : 0, getMoscowISO(), getMoscowISO(), job.id);

  if (humanError) console.log(`[LeadSearch] Job #${job.id}: ${humanError}`);
  res.json({ success: true, paused: shouldPause, consecutive_errors: errors });
});

export default router;
