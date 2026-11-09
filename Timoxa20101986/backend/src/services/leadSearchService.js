import { callOpenRouter, parseJsonReply } from './aiService.js';

// ---------------------------------------------------------------------------
// AI lead search: turning a sentence into a search plan, and turning scraped
// profiles into scored leads.
//
// Two AI calls bracket the Instagram work:
//   1. buildSearchPlan  — "нутрициологи в Москве" → hashtags / keywords / places
//   2. scoreCandidates  — profile rows → score, geo, confidence, reason
//
// Everything between them is done by the extension against Instagram, paced by
// routes/lead-search.js. No Instagram access happens in this file.
// ---------------------------------------------------------------------------

// Deliberately small. Every extra source multiplies the request budget spent
// before a single lead is scored, and a long tail of vague hashtags is where
// result quality goes to die.
export const PLAN_LIMITS = {
  MAX_HASHTAGS: 8,
  MAX_KEYWORDS: 5,
  MAX_PLACES: 4,
  MAX_EXCLUDE: 20,
};

const PLAN_SYSTEM_PROMPT = `Ты эксперт по поиску аудитории в Instagram.
Пользователь описывает, каких лидов он ищет. Твоя задача — превратить это в план поиска по Instagram.

Верни ТОЛЬКО валидный JSON, без пояснений и без markdown-разметки, строго такой структуры:
{
  "niche": "короткое название ниши",
  "geo": "гео из запроса или пустая строка",
  "audience": "одно предложение: кто именно нужен и по каким признакам его узнать",
  "hashtags": ["без решётки, нижний регистр"],
  "keywords": ["фразы для поиска аккаунтов"],
  "places": ["названия мест для гео-поиска"],
  "exclude": ["стоп-слова"],
  "min_followers": число или null,
  "max_followers": число или null
}

ПРАВИЛА:
- hashtags: не более ${PLAN_LIMITS.MAX_HASHTAGS}. Смешивай узкие с гео ("нутрициологмосква") и широкие по нише ("нутрициолог"). Узкие ставь первыми — они дают более чистых лидов. Пиши на том языке, на котором реально тегают посты в этой нише и в этом гео.
- keywords: не более ${PLAN_LIMITS.MAX_KEYWORDS}. Так люди подписывают себя в имени профиля, например "нутрициолог москва".
- places: не более ${PLAN_LIMITS.MAX_PLACES}. Только если в запросе есть гео. Названия конкретных мест, которые реально существуют как гео-метки Instagram (город, район, известное заведение). Если гео нет — пустой массив.
- exclude: стоп-слова, по которым видно, что это не тот аккаунт — магазины, опт, доставка, курсы, агрегаторы, боты. Не более ${PLAN_LIMITS.MAX_EXCLUDE}.
- min_followers / max_followers: только если пользователь назвал их явно или они очевидно следуют из запроса. Иначе null.
- Никаких выдуманных названий брендов и аккаунтов.`;

function cleanList(value, max, transform) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const s = transform(String(item ?? '').trim());
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function cleanHashtag(s) {
  // Instagram tags are letters/digits/underscore — Cyrillic included — and are
  // always addressed lowercase.
  const stripped = s.replace(/^#+/, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
  return stripped.length >= 2 && stripped.length <= 60 ? stripped : '';
}

function cleanPhrase(s) {
  const stripped = s.replace(/\s+/g, ' ').trim();
  return stripped.length >= 2 && stripped.length <= 80 ? stripped : '';
}

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Applied to both AI output and user-edited plans coming back from the UI, so
// a hand-typed "#Нутрициолог Москва" ends up in the same shape the extension
// can actually query.
export function normalizePlan(raw) {
  const plan = raw && typeof raw === 'object' ? raw : {};

  let min = cleanNumber(plan.min_followers);
  let max = cleanNumber(plan.max_followers);
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  return {
    niche: String(plan.niche || '').slice(0, 120),
    geo: String(plan.geo || '').slice(0, 120),
    audience: String(plan.audience || '').slice(0, 400),
    hashtags: cleanList(plan.hashtags, PLAN_LIMITS.MAX_HASHTAGS, cleanHashtag),
    keywords: cleanList(plan.keywords, PLAN_LIMITS.MAX_KEYWORDS, cleanPhrase),
    places: cleanList(plan.places, PLAN_LIMITS.MAX_PLACES, cleanPhrase),
    exclude: cleanList(plan.exclude, PLAN_LIMITS.MAX_EXCLUDE, s => s.toLowerCase()),
    min_followers: min,
    max_followers: max,
  };
}

export function planSourceCount(plan) {
  return (plan.hashtags?.length || 0) + (plan.keywords?.length || 0) + (plan.places?.length || 0);
}

export async function buildSearchPlan(db, queryText) {
  const query = String(queryText || '').trim();
  if (query.length < 3) throw new Error('Опишите, каких лидов вы ищете — хотя бы несколько слов');

  const reply = await callOpenRouter(
    db,
    PLAN_SYSTEM_PROMPT,
    `Запрос пользователя: ${query}\n\nСоставь план поиска.`,
    900
  );

  const plan = normalizePlan(parseJsonReply(reply));
  if (planSourceCount(plan) === 0) {
    throw new Error('AI не смог составить план по этому запросу. Опишите нишу конкретнее.');
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Pre-filter: free, local, runs before we spend one Instagram request per
// profile. This is what keeps a search fast — we enrich the ~100 candidates
// worth enriching, not all 500 we discovered.
// ---------------------------------------------------------------------------

// Discovery surfaces are full of accounts that are never a person in a niche.
// These are checked against the username/full name, not the bio, because at
// pre-filter time the bio has not been fetched yet.
const JUNK_PATTERNS = [
  /\bshop\b/i, /\bstore\b/i, /\bmarket\b/i, /\bopt\b/i,
  /магаз/i, /опт[оа]/i, /достав/i, /скидк/i, /распродаж/i,
  /\bofficial\b/i, /\bnews\b/i, /новост/i,
];

export function prefilterCandidate(plan, row) {
  const username = String(row.username || '').toLowerCase();
  if (!username) return { keep: false, reason: 'пустой username' };

  const haystack = [username, row.full_name, row.post_caption]
    .filter(Boolean).join(' ').toLowerCase();

  for (const word of plan.exclude || []) {
    if (word && haystack.includes(word)) {
      return { keep: false, reason: `стоп-слово "${word}"` };
    }
  }
  for (const re of JUNK_PATTERNS) {
    if (re.test(haystack)) {
      return { keep: false, reason: 'похоже на магазин или паблик, а не на человека' };
    }
  }
  return { keep: true, reason: null };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// 30 profiles per call balances speed and quality — model gets enough context
// for consistent scoring while limiting API request overhead and token usage.
export const SCORE_BATCH = 30;

const SCORE_SYSTEM_PROMPT = `Ты оцениваешь профили Instagram на соответствие запросу клиента.

Верни ТОЛЬКО валидный JSON без markdown:
{"results":[{"username":"...","score":0-100,"geo":"город или страна или пустая строка","geo_confidence":"high|medium|none","reason":"до 12 слов"}]}

ПРАВИЛА ОЦЕНКИ:
- score — насколько профиль соответствует описанию нужной аудитории. 80+ только если по био явно видно, что это тот самый человек. 40-79 — похоже, но без прямых подтверждений. Ниже 40 — не подходит.
- Магазины, оптовики, агрегаторы, боты, пустые и заброшенные профили — score ниже 20.
- geo: определяй по городу, стране, флагу, коду телефона, адресу или языку в био.
- geo_confidence: "high" — гео взято из гео-метки поста или прямо написано в био. "medium" — косвенный признак (код телефона, язык, район). "none" — определить нельзя, тогда geo пустая строка.
- reason — коротко и по делу на русском, почему такая оценка.
- Верни ровно по одному объекту на каждый переданный профиль, с тем же username.`;

function profileForPrompt(row) {
  const parts = [`username: ${row.username}`];
  if (row.full_name) parts.push(`имя: ${row.full_name}`);
  if (row.bio) parts.push(`био: ${String(row.bio).replace(/\s+/g, ' ').slice(0, 400)}`);
  if (Number.isFinite(row.follower_count)) parts.push(`подписчиков: ${row.follower_count}`);
  if (Number.isFinite(row.post_count)) parts.push(`постов: ${row.post_count}`);
  if (row.external_url) parts.push(`ссылка: ${row.external_url}`);
  if (row.post_location) parts.push(`гео-метка поста: ${row.post_location}`);
  if (row.post_caption) parts.push(`подпись поста: ${String(row.post_caption).replace(/\s+/g, ' ').slice(0, 200)}`);
  if (row.is_private) parts.push('закрытый профиль');
  return parts.join('\n');
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cleanConfidence(value) {
  const s = String(value || '').toLowerCase();
  return ['high', 'medium', 'none'].includes(s) ? s : 'none';
}

// Returns a Map keyed by lowercase username. Callers must tolerate a missing
// entry: a model that skips a profile should leave it unscored for a retry,
// not silently mark it rejected.
export async function scoreCandidates(db, plan, rows) {
  const batch = rows.slice(0, SCORE_BATCH);
  if (batch.length === 0) return new Map();

  const criteria = [
    `Ниша: ${plan.niche || '—'}`,
    `Нужная аудитория: ${plan.audience || plan.niche || '—'}`,
    plan.geo ? `Гео: ${plan.geo}` : null,
    plan.min_followers !== null ? `Минимум подписчиков: ${plan.min_followers}` : null,
    plan.max_followers !== null ? `Максимум подписчиков: ${plan.max_followers}` : null,
  ].filter(Boolean).join('\n');

  const userPrompt = `Критерии клиента:\n${criteria}\n\nПрофили:\n\n${
    batch.map((r, i) => `--- Профиль ${i + 1} ---\n${profileForPrompt(r)}`).join('\n\n')
  }\n\nОцени каждый профиль.`;

  const reply = await callOpenRouter(db, SCORE_SYSTEM_PROMPT, userPrompt, 200 * batch.length);
  const parsed = parseJsonReply(reply);
  const list = Array.isArray(parsed?.results) ? parsed.results : [];

  const out = new Map();
  for (const item of list) {
    const username = String(item?.username || '').trim().toLowerCase().replace(/^@/, '');
    if (!username) continue;
    const confidence = cleanConfidence(item.geo_confidence);
    out.set(username, {
      score: clampScore(item.score),
      geo: confidence === 'none' ? '' : String(item.geo || '').slice(0, 80),
      geo_confidence: confidence,
      reason: String(item.reason || '').slice(0, 200),
    });
  }
  return out;
}

// Follower bounds are checked here rather than in the prompt: they are exact
// numbers and a model asked to respect them will occasionally round or forgive.
export function isMatch(plan, row, minScore) {
  if ((row.ai_score ?? 0) < minScore) return false;
  const followers = row.follower_count;
  if (plan.min_followers !== null && Number.isFinite(followers) && followers < plan.min_followers) return false;
  if (plan.max_followers !== null && Number.isFinite(followers) && followers > plan.max_followers) return false;
  return true;
}
