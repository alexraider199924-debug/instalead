import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeHooks, normalizeHook, clampWords, buildSystemPrompt, cleanCaption, prepareCaptions, parseNotesReply, normalizeSummary, buildFallbackSummary, factualEvidenceScore, ENRICH_BATCH, ENRICH_VERSION, HOOK_COUNT, HOOK_MIN_WORDS, HOOK_MAX_WORDS } from '../src/services/contactEnrichService.js';
import { createEnrichJob, jobWithProgress, enrichReadiness } from '../src/services/contactEnrichJob.js';
import { getEnrichTask, autoFinish } from '../src/routes/contact-enrich.js';
import { getDB } from '../src/db/workspaceManager.js';

// A workspace of its own so the test never touches a real contacts database.
// getDB caches one handle per workspace, so every test shares it and the file
// is removed once at the end rather than per test.
const WORKSPACE = 'test_contact_enrich';
const DB_FILE = join(process.env.INSTALEAD_DATA_DIR || 'data', `instaworm_${WORKSPACE}.db`);

after(() => {
  if (existsSync(DB_FILE)) {
    try { unlinkSync(DB_FILE); } catch {}
  }
});


test('multilingual summaries are not rejected by the old Russian-prefix/evidence trap', () => {
  const summary = normalizeSummary('Jerry is personal trainer en online fitness coach; 15 weken, -14 kilo en van 85 naar 74,3 kg in 13 weken cut.');
  assert.ok(summary.toLowerCase().startsWith('в профиле '));

  const source = 'Jerry personal trainer online fitness coach Ik help mannen vrouwen 15 weken 14 kilo 13 weken cut 85KG 74,3';
  const score = factualEvidenceScore(summary, ['personal trainer', '15 weken', '74,3 kg'], ['15 weken, -14 kilo', '74,3 kg'], source);
  assert.ok(score >= 2, `expected grounded evidence, got ${score}`);
});

test('extractive fallback always produces a grounded note for a readable profile', () => {
  const row = {
    username: 'samenfit.jerry',
    bio: 'personal trainer | online fitness coach | help mannen & vrouwen naar gezond, sterk leven in 16 weken',
    posts: [
      '15 weken. - 14 kilo. Vandaag deel ik mijn traject.',
      '13 weken in de cut. Van 85KG naar 74,3. Nog 6 weken tot mijn fotoshoot.',
      'Persoonlijk trainings- en voedingsplan. Wekelijkse check-ins.'
    ]
  };
  const summary = buildFallbackSummary(row, 120);
  assert.match(summary, /^В профиле/);
  assert.match(summary, /15 weken|14 kilo/i);
  assert.match(summary, /74,3/i);
});

test('hooks are normalized into the word band and weak ones are dropped', () => {
  const hooks = normalizeHooks([
    'разбирает чужие ошибки в забегах',      // 5 words — ok
    'спорит с «набором массы за месяц».',   // trailing punctuation stripped
    '— ведёт офлайн-группы набором веса',   // leading dash stripped, 4 words — dropped
    'берёт учеников на офлайн тренировки',  // 5 words — ok
  ]);

  assert.equal(hooks.length, 3, 'the 4-word hook is dropped, the rest survive');
  assert.ok(!hooks.some(h => h.startsWith('ведёт')), 'under-minimum hook rejected');
  assert.ok(hooks.includes('берёт учеников на офлайн тренировки'), 'valid hook kept');

  for (const h of hooks) {
    const words = h.split(' ').length;
    assert.ok(words >= 5 && words <= 7, `"${h}" is ${words} words`);
    assert.doesNotMatch(h, /^["'«»\-–—*•]/);
  }
});

test('an over-long hook is cut to the band instead of dropped', () => {
  const hooks = normalizeHooks(['очень длинный крючок который явно вылезает за семь слов']);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].split(' ').length, 7);
});

test('duplicate hooks collapse', () => {
  const hooks = normalizeHooks([
    'разбирает чужие ошибки в забегах',
    'разбирает чужие ошибки в забегах',
    'спорит с набором массы за месяц',
  ]);
  assert.equal(hooks.length, 2);
});

test('non-array hook input yields nothing instead of throwing', () => {
  assert.deepEqual(normalizeHooks(null), []);
  assert.deepEqual(normalizeHooks('строка'), []);
});

test('an over-long summary is cut at a sentence boundary, not mid-word', () => {
  const text = Array.from({ length: 40 }, (_, i) => `слово${i}`).join(' ') + '. Хвост ещё тут.';
  const cut = clampWords(text, 20);
  assert.ok(cut.split(' ').length <= 20, 'result respects the cap');
  assert.ok(!cut.includes('слово20'), 'stopped before the cap, not after');
});

test('a short summary is returned untouched', () => {
  const text = 'В профиле обучение бегу, 12 лет практики.';
  assert.equal(clampWords(text, 90), text);
});

test('normalizeHook strips decorations and enforces the band', () => {
  assert.equal(normalizeHook('  «разбирает чужие ошибки в забегах».  '), 'разбирает чужие ошибки в забегах');
  assert.equal(normalizeHook('бег'), null);
});

test('the enrichment prompt pins the contract the send step depends on', () => {
  const prompt = buildSystemPrompt({ summaryLang: 'ru', maxWords: 90 });

  // The parse side is parseJsonReply against this exact shape; if the prompt
  // stops naming it, notes come back unparseable and the whole batch is lost.
  assert.match(prompt, /"results"/);
  assert.match(prompt, /"summary"/);
  assert.match(prompt, /"hooks"/);
  assert.match(prompt, /"username"/);
  assert.match(prompt, /без markdown/i);

  // The note prefix is what the send-side context is anchored on.
  assert.match(prompt, /В профиле/);

  // The word band is derived from the configured cap, not hardcoded, so the
  // 90-word setting and the prompt cannot disagree.
  assert.match(prompt, /ориентир 60–90 слов/);

  assert.match(prompt, new RegExp(`ровно ${HOOK_COUNT}`));
  assert.match(prompt, new RegExp(`${HOOK_MIN_WORDS}–${HOOK_MAX_WORDS} слов`));

  // "Do not write the message" is the whole reason this is a separate call:
  // a model asked for a DM will happily produce one and skip the note.
  assert.match(prompt, /Сообщение человеку НЕ пишешь/i);

  // Both directions of the hook example matter — the good one is a template,
  // the bad one is the failure mode the send gate exists to catch.
  assert.match(prompt, /дословных фрагментов|evidence_quotes/i);
  assert.match(prompt, /Нельзя додумывать/i);
});

test('the prompt follows the configured note language', () => {
  const en = buildSystemPrompt({ summaryLang: 'en', maxWords: 90 });
  assert.match(en, /английском/);
  // An unknown code must fall back to Russian rather than leaking a raw key
  // like "Пиши на zz" into the prompt.
  const weird = buildSystemPrompt({ summaryLang: 'zz', maxWords: 90 });
  assert.match(weird, /русском/);
});

test('ENRICH_VERSION is bumped whenever the note contract changes', () => {
  // The send path compares the stored version before trusting hooks; a stale
  // note with v1/v2-shaped meta must not be graded by v3 rules. v3 changed what
  // a note contains (ordered summary, hooks that reach past self-description),
  // so v2 notes are marked stale in the Contacts table and can be re-run.
  assert.ok(Number.isInteger(ENRICH_VERSION) && ENRICH_VERSION >= 3);
});

test('the note contract asks for dense grounded intelligence', () => {
  const prompt = buildSystemPrompt({ summaryLang: 'ru', maxWords: 90 });

  assert.match(prompt, /СНАЧАЛА СОБЕРИ ФАКТЫ, ПОТОМ ПИШИ SUMMARY/);
  assert.match(prompt, /5–12 конкретных деталей/);
  assert.match(prompt, /Числа, названия, бренды/);
  assert.match(prompt, /Подписей постов нельзя игнорировать/);
  assert.match(prompt, /evidence_quotes/);
  assert.match(prompt, /НЕЛЬЗЯ добирать объём выдумкой/);
  assert.match(prompt, /Если summary пишется не на русском, это допустимо/);
});

test('captions made only of hashtags stop occupying the post slots', () => {
  assert.equal(cleanCaption('#спорт #здоровье #осень'), '');
  assert.equal(cleanCaption('🔥🔥'), '');

  // A real fact survives stripping of its hashtag tail.
  const kept = cleanCaption('Открыли набор в офлайн-группу по вторникам #осень #бег');
  assert.match(kept, /офлайн-группу/);
  assert.doesNotMatch(kept, /#/);

  const prepared = prepareCaptions([
    '#бег #спорт',
    'Открыли набор в офлайн-группу по вторникам',
    'Открыли набор в офлайн-группу по вторникам #новое',
    'Разбираем чужие ошибки в забегах на неделе',
  ], 10);

  assert.equal(prepared.length, 2, 'one real caption, one duplicate and one hashtag post');
  assert.match(prepared[0], /офлайн-группу/);
  assert.match(prepared[1], /ошибки в забегах/);
});

test('a batch the model truncated keeps the notes it did finish', () => {
  const good = [
    { username: 'alpha_one', summary: 'В профиле продаёт курсы по бегу.', hooks: ['разбирает чужие ошибки в забегах', 'ведёт офлайн-группы набором веса', 'берёт учеников на тренировки'] },
    { username: 'beta_two', summary: 'В профиле ведёт студию керамики.', hooks: ['лепит горшки на заказы в мастерской', 'учит гончарному делу новичков', 'делает посуду из местной глины'] }
  ];

  // The third object is cut off mid-string — exactly what a spent token budget
  // produces. parseJsonReply throws here, which used to discard all ten notes
  // in the batch because of the ninth one.
  const truncated = '{"results":[' +
    JSON.stringify(good[0]) + ',' +
    JSON.stringify(good[1]) + ',' +
    '{"username":"gamma_three","summary":"В профиле продаёт мебель';

  const parsed = parseNotesReply(truncated);
  assert.equal(parsed.length, 2, 'the two complete notes survived');
  assert.equal(parsed[0].username, 'alpha_one');
  assert.equal(parsed[1].username, 'beta_two');

  // The half-written note is deliberately left out rather than closed and
  // stored. "В профиле продаёт мебель" reads as a finished fact about someone
  // it never finished reading; the profile is simply absent from the map and
  // the caller asks for it again with a larger budget.
  assert.ok(!parsed.some(p => p.username === 'gamma_three'));

  // A clean reply parses the ordinary way, unchanged.
  assert.equal(parseNotesReply(JSON.stringify({ results: good })).length, 2);

  // And a reply that is not JSON at all yields nothing instead of throwing —
  // the caller reads that as "the model produced nothing", which is honest.
  assert.deepEqual(parseNotesReply('Извините, я не могу выполнить это.'), []);
  assert.deepEqual(parseNotesReply(''), []);
  assert.deepEqual(parseNotesReply(null), []);
});

test('enrichment refuses to start without an AI key and says where to fix it', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare("DELETE FROM settings WHERE key = 'openrouter_api_key'").run();
  db.prepare(`DELETE FROM contact_enrich_jobs`).run();

  const blocked = enrichReadiness(db);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.has_ai_key, false);

  const blocker = blocked.blockers.find(b => b.code === 'no_ai_key');
  assert.ok(blocker, 'the missing key is a hard blocker');
  assert.equal(blocker.fix, '/integrations', 'the blocker names where to go');

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('openrouter_api_key', 'sk-test')").run();

  const ready = enrichReadiness(db);
  assert.equal(ready.ready, true, 'with a key and no running job, enrichment can start');
  assert.equal(ready.blockers.length, 0);
  assert.equal(typeof ready.extension.online, 'boolean');

  // A running job blocks a second one, and the UI needs the id to jump to it.
  db.prepare(
    "INSERT INTO contact_enrich_jobs (status, phase, total_count, run_minutes) VALUES ('running', 'scrape', 5, 60)"
  ).run();
  const busy = enrichReadiness(db);
  assert.equal(busy.ready, false);
  assert.ok(busy.blockers.some(b => b.code === 'job_active' && b.job_id));
  db.prepare(`DELETE FROM contact_enrich_jobs`).run();

  db.prepare("DELETE FROM settings WHERE key = 'openrouter_api_key'").run();
});

test('job lifecycle: create, issue a task, bank scraped profiles', async () => {
  const db = await getDB(WORKSPACE);

  for (const username of ['alpha_one', 'beta_two']) {
    db.prepare('INSERT OR IGNORE INTO contacts (username, full_name) VALUES (?, ?)').run(username, username);
  }

  const job = createEnrichJob(db, { usernames: ['@Alpha_One', 'alpha_one', 'beta_two'], runMinutes: 30 });
  assert.ok(job, 'job created');
  // A @-prefixed and a duplicated input are the same contact.
  assert.equal(job.total_count, 2);
  assert.equal(job.status, 'pending');

  // A contact with no lead row gets one — the send path only joins leads, and
  // a freshly inserted lead must not read as "never enriched" while queued.
  const lead = db.prepare('SELECT * FROM leads WHERE username = ?').get('alpha_one');
  assert.ok(lead, 'lead row created for the note to land in');
  assert.equal(lead.enrich_status, 'queued');

  const issued = await getEnrichTask(db);
  assert.equal(issued.task.type, 'enrich_contacts');
  assert.deepEqual(issued.task.usernames.sort(), ['alpha_one', 'beta_two']);
  assert.ok(issued.task.delay_ms > 0, 'the server owns the pacing');
  assert.ok(issued.task.usernames.length <= ENRICH_BATCH);

  // Phase 1: profiles come back from the extension and are banked raw. The AI
  // pass runs afterwards; what matters here is that the rows are marked scraped
  // and ready for the model.
  db.prepare(`
    UPDATE contact_enrich_results
    SET scraped = 1, bio = ?, follower_count = ?, posts_json = ?, full_name = ?
    WHERE job_id = ?
  `).run('обучение бегу', 14000, JSON.stringify(['пост один', 'пост два']), 'Alpha One', job.id);

  const banked = db.prepare('SELECT * FROM contact_enrich_results WHERE job_id = ?').all(job.id);
  assert.equal(banked.length, 2);
  assert.ok(banked.every(r => r.scraped === 1));
  assert.equal(banked[0].posts_json, JSON.stringify(['пост один', 'пост два']));

  // Phase 2: nothing left to hand out, so the job closes itself.
  db.prepare('UPDATE contact_enrich_results SET summarized = 1 WHERE job_id = ?').run(job.id);
  const finished = await getEnrichTask(db);
  assert.equal(finished.task, null);
  assert.equal(finished.job_completed, job.id);
});

test('enrichment yields while another Instagram job owns the session', async () => {
  const db = await getDB(WORKSPACE);
  const job = createEnrichJob(db, { usernames: ['alpha_one'] });
  assert.ok(job);

  // Lead Finder and AI Search run first by policy; enrichment must never take
  // the Instagram session away from a campaign-driven job.
  db.prepare("INSERT OR IGNORE INTO lead_search_jobs (query_text, plan_json, target_count) VALUES ('x', '{}', 10)").run();
  const blocked = await getEnrichTask(db);
  assert.equal(blocked.task, null, 'no task while AI search is active');

  db.prepare('DELETE FROM lead_search_jobs').run();
  const allowed = await getEnrichTask(db);
  assert.ok(allowed.task, 'task resumes once search is clear');
});

const isoAgo = minutes =>
  new Date(Date.now() - minutes * 60_000).toISOString();

test('a time-boxed job pauses itself instead of running forever', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['alpha_one'], runMinutes: 60 });

  // A job whose last progress is older than its block should stop being served
  // and say why, instead of burning the account all night.
  //
  // Written as an ISO-8601 string because that is exactly what the route
  // stores. Seeding it through datetime('now', ...) instead would produce
  // SQLite's space-separated format and quietly pass a comparison the real
  // code can never make.
  db.prepare(
    "UPDATE contact_enrich_jobs SET status='running', last_progress_at = ? WHERE id = ?"
  ).run(isoAgo(90), job.id);

  const expired = await getEnrichTask(db);
  assert.equal(expired.task, null);
  assert.match(expired.message || '', /блок/i);
  assert.equal(db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id).status, 'paused');
});

test('a job inside its block keeps running', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['beta_two'], runMinutes: 60 });
  db.prepare(
    "UPDATE contact_enrich_jobs SET status='running', last_progress_at = ? WHERE id = ?"
  ).run(isoAgo(5), job.id);

  const served = await getEnrichTask(db);
  assert.ok(served.task, 'a five-minute-old job is still inside its hour');
});

test('an abandoned job is reclaimed as paused, not left running forever', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['beta_two'] });

  // A day-old untouched run is not "the extension took a nap", it is abandoned.
  // Left running it would block every future enrichment job for good.
  db.prepare(
    "UPDATE contact_enrich_jobs SET status='running', last_progress_at = ? WHERE id = ?"
  ).run(isoAgo(60 * 24), job.id);

  await getEnrichTask(db);
  const reclaimed = db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id);
  assert.equal(reclaimed.status, 'paused');
});

test('a freshly resumed job is not immediately reclaimed as stale', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['beta_two'], runMinutes: 60 });

  // Reclamation must not fire on the clock alone: a job the user just
  // continued is seconds old, and pausing it again would make "Продолжить"
  // look broken.
  db.prepare(
    "UPDATE contact_enrich_jobs SET status='running', last_progress_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), job.id);

  await getEnrichTask(db);
  assert.notEqual(db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id).status, 'paused');
});

test('a contact with no data is counted once, not as done and failed', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['alpha_one'] });
  const row = db.prepare('SELECT id FROM contact_enrich_results WHERE job_id = ?').get(job.id);

  // What the scraped route writes for a private account with no bio.
  db.prepare(
    'UPDATE contact_enrich_results SET scraped = 1, summarized = 1, error = ? WHERE id = ?'
  ).run('Нет публичных данных (приватный профиль или пустое био)', row.id);

  const p = jobWithProgress(db, db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(job.id));

  // The reported symptom: "Готово 1 / Без данных 1 / 0%" for a single contact.
  // summarized counted every summarized=1 row — including the failure path,
  // which also sets summarized=1 — so the same row was reported twice.
  assert.equal(p.summarized, 0, 'a row with no note is not "done"');
  assert.equal(p.failed, 1, 'it is "без данных"');
  assert.equal(p.done, 1, 'closed exactly once');
  assert.equal(p.percent, 100, 'a fully banked job reads as 100%, not 0%');
});

test('a job stored without total_count still reports real progress', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['alpha_one', 'beta_two'] });

  // The older shape: total_count stayed 0 while rows existed. Dividing by it
  // gave 0% for a job that was a third done, forever.
  db.prepare('UPDATE contact_enrich_jobs SET total_count = 0 WHERE id = ?').run(job.id);
  db.prepare('UPDATE contact_enrich_results SET scraped = 1, summarized = 1, summary = ? WHERE job_id = ? AND username = ?')
    .run('В профиле бегает по утрам.', job.id, 'alpha_one');

  const p = jobWithProgress(db, db.prepare('SELECT * FROM contact_enrich_jobs WHERE id = ?').get(job.id));
  assert.equal(p.total, 2, 'falls back to the number of real rows');
  assert.equal(p.done, 1);
  assert.equal(p.percent, 50);
});

test('a job closes itself on read once every contact is banked', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['alpha_one'] });

  await getEnrichTask(db);
  db.prepare('UPDATE contact_enrich_results SET scraped = 1, summarized = 1 WHERE job_id = ?').run(job.id);

  // No extension poll: the browser was closed after the last report. Without a
  // read-triggered close the row stays "running" at a bar that cannot move.
  assert.equal(db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id).status, 'running');

  autoFinish(db, job.id);
  const closed = db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id);
  assert.equal(closed.status, 'completed');
});

test('a job with contacts still queued is not closed early', async () => {
  const db = await getDB(WORKSPACE);
  db.prepare('DELETE FROM contact_enrich_jobs').run();
  const job = createEnrichJob(db, { usernames: ['alpha_one', 'beta_two'] });

  db.prepare('UPDATE contact_enrich_results SET scraped = 1, summarized = 1 WHERE job_id = ? AND username = ?')
    .run(job.id, 'alpha_one');

  autoFinish(db, job.id);
  assert.notEqual(
    db.prepare('SELECT status FROM contact_enrich_jobs WHERE id = ?').get(job.id).status,
    'completed',
    'one banked row out of two must not close the job'
  );
});
