// ---------------------------------------------------------------------------
// Profile enrichment — the first of the two AI calls.
//
// One job of this service: turn raw Instagram profile data into the two-tier
// note the send step reads later.
//
//   summary  — ≤ summary_max_words words, starts with "В профиле" and contains dense, concrete profile facts.
//              model should *know* about this person.
//   hooks    — exactly three fragments of 5–7 words. What it should *say*.
//
// The split exists because a single 90-word paragraph is good at the first job
// and bad at the second. Given only a paragraph, a model writing the DM drifts
// toward the summary's most general sentences — "эксперт в своей нише" — which
// is the least personalizable part of it. Given three short concrete fragments,
// it reaches for the specific one instead: "разбирает чужие ошибки в забегах".
// The hooks are also what the send-side quality gate grounds against, which is
// a far sharper test than comparing against 90 words of prose.
//
// The summary itself has an order, because a note written as an unordered list
// of profile facts is no more usable than no note. It opens with what the
// person earns from this account, then the offline context around it, then two
// specifics from the posts. That is the order in which a stranger's message
// stops sounding like a stranger's message.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { callOpenRouter, isValidModelId } from './aiService.js';
import { normalizeAgentContext } from './offerContext.js';

// Respect the Integrations setting, falling back to the strongest
// When nothing is configured — so existing installs keep working.
function personalizationModel(db) {
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_model'").get()?.value;
  const candidate = String(saved || '').trim();
  return isValidModelId(candidate) ? candidate : 'anthropic/claude-sonnet-4';
}

// Three summaries per call. Keeping the batch small is intentional: each summary is
// ~90 words of considered prose plus three hooks, so a large batch degrades the
// per-profile care far faster than it saves request overhead.
export const ENRICH_BATCH = 3;

export const HOOK_COUNT = 3;
export const HOOK_MIN_WORDS = 5;
export const HOOK_MAX_WORDS = 7;

// Bumping this marks every stored summary as stale. The send path compares it
// before trusting a note, so an old prompt's output never silently becomes the
// basis of a message written to a new prompt's spec.
//
// v3 changed what a note contains, not just how it is worded: the summary is
// now ordered (what he earns → offline context → post specifics) instead of an
// unordered list of profile facts, and hooks are required to reach past what
// the person wrote about themselves. Notes written under v1/v2 still read, but
// the UI marks them stale so the user can re-run rather than trust a note
// produced by a weaker contract.
export const ENRICH_VERSION = 8;

// Pacing is declared next to the batch size it derives from, so the two cannot
// drift: the route reads these, not local copies.
export const ENRICH_LIMITS = {
  DELAY_MIN_MS: 1200,
  DELAY_MAX_MS: 2800,
  // Spacing between two profiles inside one batch. The delay above spaces the
  // batches; without a gap inside them the extension fires ten profile reads
  // back to back, which is the shape Instagram's checkpoint looks for. Declared
  // here and shipped with the task so the extension cannot shorten it and the
  // time estimate below cannot drift from what actually runs.
  PROFILE_GAP_MIN_MS: 15000,
  PROFILE_GAP_MAX_MS: 15000,
  // Rest between batches, not between profiles. Reading profiles back to back
  // is what triggers Instagram's checkpoint; the pauses are what keep the
  // account alive.
  COOLDOWN_MIN_MS: 20000,
  COOLDOWN_MAX_MS: 45000,
  BATCH_SIZE: ENRICH_BATCH,
  DEFAULT_RUN_MINUTES: 60,
  MAX_RUN_MINUTES: 720,
  MAX_CONTACTS_PER_JOB: 1000,
  MAX_CONSECUTIVE_ERRORS: 3,
  // How long an untouched job waits before being declared abandoned. Much
  // longer than a run_minutes block on purpose: the block expiry is the normal
  // stop, this is the "user closed the laptop a week ago" case.
  DISCONNECT_MINUTES: 360,
  // Ten, not eight: the extension already scraped twelve, and captions that
  // were pure hashtags no longer consume a slot, so the two spare posts cost
  // nothing but raise the chance that one of them says what the person sells.
  MAX_POSTS_PER_PROFILE: 12
};

const LANG_NAMES = {
  ru: 'русском', en: 'английском', es: 'испанском', de: 'немецком',
  fr: 'французском', it: 'итальянском', pt: 'португальском', nl: 'нидерландском',
  pl: 'польском', tr: 'турецком', ar: 'арабском', hi: 'хинди'
};

const wordCount = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// Cuts at a sentence boundary so an over-long summary loses its last clause
// rather than ending mid-word. The prompt already asks for the cap; this is the
// enforcement, because a model asked nicely still overshoots.
export function clampWords(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (wordCount(value) <= max) return value;

  const words = value.split(' ');
  let cut = '';
  for (let i = 0; i < Math.min(words.length, max); i++) {
    const candidate = words.slice(0, i + 1).join(' ');
    if (/[.!?…]$/.test(candidate)) cut = candidate;
    // A long run without a sentence end means the model wrote a run-on; fall
    // back to the hard cap rather than returning nothing.
    if (i === max - 1) cut = cut || candidate;
  }
  return cut.replace(/[ ,;:]+$/, '');
}

// Hooks are the load-bearing part, so they are normalized hard: exactly three,
// each inside the word band, none of them a copy of the summary's own phrasing.
// A hook that is too short ("бег") passes a word-count check but gives the send
// step nothing to work with, so short hooks are padded out by rejection — the
// model is asked again rather than accepted as-is.
// Word-band enforcement for hooks. Exported so the contract is testable without
// a model in the loop.
export function normalizeHook(raw) {
  const value = String(raw || '').replace(/^[\s"'«»\-–—*•]+|[\s"'«».,;:]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const words = value.split(' ');
  if (words.length < HOOK_MIN_WORDS) return null;
  // Trim overlong hooks instead of discarding them. The first 7 words preserve
  // the concrete subject in most model outputs and keep the send-side contract
  // deterministic; a later repair pass can replace the hook with a better one.
  return words.slice(0, HOOK_MAX_WORDS).join(' ');
}

export function normalizeHooks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const hook = normalizeHook(raw);
    if (hook && !out.some(h => h.toLowerCase() === hook.toLowerCase())) out.push(hook);
    if (out.length === HOOK_COUNT) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// Exported so the prompt contract is testable without spending a call: the
// JSON shape and the word band are load-bearing for the send step and cannot
// be allowed to drift by accident.
export function buildSystemPrompt({ summaryLang, maxWords }) {
  const langName = LANG_NAMES[summaryLang] || 'русском';
  return `Ты создаёшь внутренний Lead Intelligence для персонализации Instagram DM. Сообщение человеку НЕ пишешь.

КРИТИЧЕСКИЙ КОНТРАКТ ДОКУМЕНТА:
1. Источник истины — только username, имя, био, ссылка и подписи постов из входного профиля.
2. Нельзя додумывать профессию, доход, интерес, результат, географию, отношения с брендами или намерения человека.
3. Каждый важный вывод должен иметь опору в одном или нескольких исходных фактах. Если опоры нет — пиши «не найдено».
4. Общие слова («эксперт», «успешный предприниматель», «развивает личный бренд», «делится полезным контентом») не считаются фактами.
5. Числа, названия, бренды, проекты, программы, мероприятия, места, должности и конкретные темы сохраняй максимально точно.
6. Подписей постов нельзя игнорировать: они часто содержат более сильные сигналы, чем био.

СНАЧАЛА СОБЕРИ ФАКТЫ, ПОТОМ ПИШИ SUMMARY:
- name: имя, только если явно указано;
- niche: конкретная сфера, только если подтверждается;
- what_does: чем занимается/что продаёт/что создаёт, с конкретикой;
- key_signals: 3–8 конкретных наблюдений;
- possible_interest: только осторожная гипотеза, явно отделённая от факта;
- facts: атомарные проверяемые факты, а не общие выводы;
- evidence_quotes: 2–5 коротких дословных фрагментов из био/подписей постов, на которых реально основан summary; не переводи эти фрагменты;
- hooks: три разных потенциальных повода для DM, каждый должен быть подтверждён источником;
- avoid: детали, которые нельзя использовать или которые легко исказить.

SUMMARY — главный источник для второго AI:
- начинается ровно с «В профиле»;
- ${60 <= maxWords ? `ориентир 60–${maxWords}` : `не более ${maxWords}`} слов;
- плотная естественная проза без заголовков и списков;
- 5–12 конкретных деталей, ЕСЛИ они реально есть в источнике;
- одна существенная деталь = одна ясная мысль, не сворачивай несколько фактов в «занимается фитнесом»;
- сначала деятельность/оффер профиля, затем контекст и география, затем конкретные сигналы из постов;
- не включай имя, число подписчиков и число постов;
- если данных мало, summary может быть коротким. НЕЛЬЗЯ добирать объём выдумкой или общими фразами.

HOOKS:
- ровно 3 разных hook, по ${HOOK_MIN_WORDS}–${HOOK_MAX_WORDS} слов каждый;
- каждый hook должен быть конкретным и пригодным для естественного упоминания в DM;
- минимум один hook по возможности должен опираться на подпись поста, а не только на био;
- не повторяй один и тот же факт тремя формулировками;
- если уникальных фактов мало, допускаются разные ракурсы одного подтверждённого факта, но НИКОГДА не добавляй новый факт.

КОНТРОЛЬ ПЕРЕД ОТВЕТОМ:
- Можно ли показать исходную строку/факт, на котором основана каждая конкретная деталь? Если нет — удали её.
- Есть ли в summary хотя бы несколько узнаваемых деталей профиля? Если да, они должны попасть в summary.
- Если профиль пустой/закрытый — не симулируй персонализацию.
- Если summary пишется не на русском, это допустимо: важнее точность и язык источника. Не проваливай ответ только из-за языка.

Верни ТОЛЬКО валидный JSON без markdown:
{"results":[{"username":"...","summary":"...","hooks":["...","...","..."],"name":"...","niche":"...","what_does":"...","key_signals":["..."],"possible_interest":"...","best_hook":"...","avoid":"...","facts":["...","..."],"evidence_quotes":["...","..."]}]}

Язык полей: ${langName}. Не добавляй оффер отправителя и не пиши готовый DM.`;
}

// A caption that is nothing but hashtags and emoji carries no fact about the
// person, but it used to occupy one of the eight post slots — and reels, which
// are most of what an active account posts, frequently caption that way. The
// model was therefore shown six empty-looking captions and three real ones, and
// the note it produced leaned on the emptiness.
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
// Emoji, pictographs, variation selectors, ZWJ and skin-tone modifiers.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}©®™]/gu;

export function cleanCaption(text) {
  const raw = String(text || '');
  const stripped = raw
    .replace(HASHTAG_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?«»"'\-–:;()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Below this there is nothing to summarize — a caption of one or two words
  // ("Сторис", "🔥") is a formatting artefact, not a fact.
  if (stripped.length < 12) return '';
  return stripped.slice(0, 700);
}

// Keeps the informative captions and drops duplicates. Two captions that
// differ only by a hashtag or an emoji are the same post published twice, and
// spending two of eight slots on one fact is how the note ends up thinner than
// the profile actually is.
export function prepareCaptions(posts, maxPosts) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(posts) ? posts : []) {
    const caption = cleanCaption(raw);
    if (!caption) continue;
    const fingerprint = caption.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(caption);
    if (out.length >= maxPosts) break;
  }
  return out;
}

function profileForPrompt(row, maxPosts) {
  const parts = [`username: ${row.username}`];
  if (row.full_name) parts.push(`имя: ${row.full_name}`);
  if (row.bio) parts.push(`био: ${String(row.bio).replace(/\s+/g, ' ').slice(0, 400)}`);
  if (row.external_url) parts.push(`ссылка: ${row.external_url}`);
  if (row.is_private) parts.push('закрытый профиль, посты не видны');

  const posts = prepareCaptions(row.posts, maxPosts);
  if (posts.length) {
    parts.push('ПОЛНЫЕ ПОДПИСИ ПОСТОВ (это основной источник конкретных фактов; используй их все, где есть полезная информация):');
    posts.forEach((p, i) => parts.push(`  ПОСТ ${i + 1}: ${p}`));
  }

  // Stated plainly rather than left for the model to infer: a profile with one
  // bio line and no captions is told as much, because "write a useful note" and
  // "there is nothing here to write about" are different instructions and only
  // one of them is honest.
  const thin = !posts.length && !String(row.bio || '').trim();
  if (thin) {
    parts.push('ОТ СЕБЯ МАТЕРИАЛА НЕТ: ни био, ни одной подписи поста. Не выдумывай ничего — верни пустую заметку.');
  } else if (posts.length < 3) {
    parts.push(`Материала мало: подписей постов всего ${posts.length}. Бери то, что есть, не добирай общими словами.`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Reply parsing
//
// A note is 90 words plus three hooks of JSON per profile, and the batch runs
// ten of them in one answer. One malformed object used to take the whole
// response down: parseJsonReply throws on the single bad character, the caller
// treats the batch as failed, and ten perfectly good notes are thrown away
// because the ninth profile had a stray quote in it. Salvage-first parsing keeps
// what parsed and blames only what did not.
// ---------------------------------------------------------------------------

const normalizeUser = value => String(value || '').trim().toLowerCase().replace(/^@/, '');

// Walks the raw text for balanced `{...}` blocks mentioning "username" and
// parses each on its own, so one bad object costs one note instead of ten.
//
// A block the model was cut off in the middle of is deliberately NOT repaired
// and closed. Its summary would be half a sentence, and a half-written note is
// worse than none: it reaches the send path and reads as a fact about the
// person that they never wrote. The profile is simply missing from the map, and
// the caller asks for it again on its own with a larger budget.
function salvageResults(text) {
  const out = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = at; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end < 0) continue;
    const chunk = text.slice(at, end + 1);
    if (!chunk.includes('"username"')) continue;
    try {
      const obj = JSON.parse(chunk);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {}
  }
  return out;
}

// Never throws. An unparseable reply yields an empty list, which the caller
// reads as "the model produced nothing" — the honest reading — rather than
// crashing a job that has already banked ten scraped profiles.
export function parseNotesReply(reply) {
  const text = String(reply || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.includes('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.results)) return parsed.results;
      if (parsed && typeof parsed === 'object' && parsed.username) return [parsed];
    } catch {}
  }

  return salvageResults(text);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// A 90-word Russian note plus three hooks and the JSON around them costs
// roughly 280–320 tokens. The budget was 220 per profile, so a full-size batch
// ran out of room partway through and the notes it did produce came back as
// truncated JSON — the single most common cause of "профили прочитаны, а
// конспектов нет".
const TOKENS_PER_PROFILE = 1200;
const SINGLE_PROFILE_TOKENS = 2200;
const DENSE_REWRITE_TOKENS = 1800;

// The entire two-step personalization pipeline uses one deterministic model.
// Other AI features may still use the model selected in Integrations.
// Personalization model is now configurable via DB settings (openrouter_model)
// instead of hardcoded. This allows using cheaper models like Gemini or GPT-4o-mini.

// The configured model supports structured outputs on OpenRouter. Using a schema here is
// important: a perfectly good answer must not be thrown away just because the
// model wrapped JSON in prose, reordered fields, or emitted a stray markdown
// fence. The schema is a transport guard; notesFromReply remains the semantic
// quality gate.
export const ENRICH_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'lead_intelligence_batch',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              username: { type: 'string' },
              summary: { type: 'string' },
              hooks: { type: 'array', items: { type: 'string' } },
              name: { type: 'string' },
              niche: { type: 'string' },
              what_does: { type: 'string' },
              key_signals: { type: 'array', items: { type: 'string' } },
              possible_interest: { type: 'string' },
              best_hook: { type: 'string' },
              avoid: { type: 'string' },
              facts: { type: 'array', items: { type: 'string' } },
              evidence_quotes: { type: 'array', items: { type: 'string' } }
            },
            required: ['username', 'summary', 'hooks', 'name', 'niche', 'what_does', 'key_signals', 'possible_interest', 'best_hook', 'avoid', 'facts', 'evidence_quotes']
          }
        }
      },
      required: ['results']
    }
  }
};

function buildUserPrompt(rows, maxPosts) {
  return `Профили:\n\n${
    rows.map((r, i) => `--- Профиль ${i + 1} ---\n${profileForPrompt(r, maxPosts)}`).join('\n\n')
  }\n\nСоставь полный Lead Intelligence по контракту выше для каждого профиля. Перед ответом внутренне выпиши атомарные факты из источника и проверь, что каждая конкретная деталь summary подтверждается ими. Если профиль бедный, сократи summary вместо заполнения общими словами. hooks должны быть ровно тремя разными и подтверждёнными источником.`;
}

function normalizeEvidenceText(value) {
  return String(value || '').toLowerCase().replace(/https?:\/\/\S+/gi, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const EVIDENCE_STOPWORDS = new Set('в и на с по из у к о а но что это как для от до не ни или уже еще также про при за над под мы вы он она они их его ее мой твой ваш наш свой быть был была были есть где когда чтобы который которая которые этот эта эти то же более менее очень просто можно человек люди профиль контент пост аккаунт'.split(' '));

function evidenceTokens(value) {
  return normalizeEvidenceText(value).split(' ').filter(w => w.length >= 5 && !EVIDENCE_STOPWORDS.has(w));
}

function evidenceScore(summary, source) {
  const src = new Set(evidenceTokens(source));
  const sum = new Set(evidenceTokens(summary));
  if (!src.size || !sum.size) return 0;
  let score = 0;
  for (const a of sum) {
    for (const b of src) {
      if (a === b || a.slice(0, 5) === b.slice(0, 5) || b.slice(0, 5) === a.slice(0, 5)) { score++; break; }
    }
  }
  return score;
}

export function summaryContentHash(summary, hooks = []) {
  return createHash('sha256')
    .update(`${normalizeEvidenceText(summary)}\n${(Array.isArray(hooks) ? hooks : []).map(normalizeEvidenceText).join('\n')}`)
    .digest('hex')
    .slice(0, 24);
}


const SUMMARY_PREFIXES = [
  /^в\s+профиле\b/i, /^in\s+(?:the\s+)?profile\b/i, /^en\s+el\s+perfil\b/i,
  /^dans\s+le\s+profil\b/i, /^im\s+profil\b/i, /^nel\s+profilo\b/i,
  /^no\s+perfil\b/i, /^in\s+het\s+profiel\b/i, /^profil(?:u|ie|em)?\b/i
];

function normalizeSummary(raw) {
  let value = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  // The old contract hard-required the Russian prefix even when summary_language=lead.
  // That made perfectly good Dutch/English/etc. summaries fail the gate. Keep a stable
  // Russian prefix only when the model did not provide any natural profile lead-in.
  if (!SUMMARY_PREFIXES.some(re => re.test(value))) value = `В профиле ${value}`;
  return value;
}

function sourceTextForRow(row) {
  const posts = Array.isArray(row?.posts) ? row.posts.map(p => typeof p === 'string' ? p : (p?.caption || p?.text || '')) : [];
  return [row?.username, row?.full_name, row?.bio, row?.external_url, ...posts].filter(Boolean).join(' ');
}

function quoteEvidence(quotes, source) {
  const normalizedSource = normalizeEvidenceText(source);
  return (Array.isArray(quotes) ? quotes : [])
    .map(q => String(q || '').replace(/\s+/g, ' ').trim())
    .filter(q => q.length >= 8)
    .map(q => ({ q, n: normalizeEvidenceText(q) }))
    .filter(({ n }) => n && (normalizedSource.includes(n) || n.split(' ').filter(Boolean).length >= 4 && n.split(' ').filter(Boolean).every(t => normalizedSource.includes(t))))
    .map(({ q }) => q)
    .slice(0, 5);
}

function factualEvidenceScore(summary, facts, quotes, source) {
  const quoteScore = quoteEvidence(quotes, source).length;
  const summaryScore = evidenceScore(summary, source);
  const factsScore = (Array.isArray(facts) ? facts : []).reduce((score, fact) => score + Math.min(2, evidenceScore(fact, source)), 0);
  // A translated summary can have zero lexical overlap with the source. In that
  // case exact source quotes or grounded facts are enough to establish provenance.
  return Math.max(summaryScore, quoteScore * 2, Math.min(4, factsScore));
}

function buildFallbackSummary(row, maxWords) {
  const bio = String(row?.bio || '').replace(/\s+/g, ' ').trim();
  const posts = prepareCaptions(row?.posts, ENRICH_LIMITS.MAX_POSTS_PER_PROFILE);
  const pieces = [];
  if (bio) pieces.push(bio);

  // Prefer captions containing numbers, offers, outcomes, or explicit first-person
  // claims. These are much safer than a generic caption like "stay motivated".
  const strong = posts.filter(p => /\d|%|kg\b|weeks?|weken|kilo|coach|coaching|trainer|help|programma|program|plan|client|klant|cut|shoot|doel|training|voeding|nutrition|fitness/i.test(p));
  for (const p of [...strong, ...posts]) {
    if (pieces.some(x => normalizeEvidenceText(x) === normalizeEvidenceText(p))) continue;
    pieces.push(p);
    if (pieces.length >= 3) break;
  }

  if (!pieces.length) return '';
  const text = `В профиле ${pieces.join('. ')}`;
  return clampWords(text, maxWords);
}

function notesFromReply(reply, maxWords, model, sourceRows = []) {
  const list = parseNotesReply(reply);
  const out = new Map();
  const clean = (v, fallback = 'не найдено') => {
    const x = String(v ?? '').replace(/\s+/g, ' ').trim();
    return x || fallback;
  };
  for (const item of list) {
    const username = normalizeUser(item?.username);
    if (!username) continue;
    const rawSummary = normalizeSummary(clean(item?.summary, ''));
    const signals = Array.isArray(item?.key_signals) ? item.key_signals.map(v => clean(v, '')).filter(Boolean).slice(0, 8) : [];
    const rawHooks = Array.isArray(item?.hooks) ? item.hooks : [];
    const bestHook = clean(item?.best_hook, '');
    const hooks = normalizeHooks([...rawHooks, bestHook]);
    const facts = Array.isArray(item?.facts) ? item.facts.map(v => clean(v, '')).filter(Boolean).slice(0, 12) : [];
    const evidenceQuotes = Array.isArray(item?.evidence_quotes) ? item.evidence_quotes.map(v => clean(v, '')).filter(Boolean).slice(0, 5) : [];
    if (!rawSummary) continue;
    const summary = clampWords(rawSummary, maxWords);
    if (wordCount(summary) < 8) continue;

    const sourceRow = sourceRows.find(r => normalizeUser(r?.username) === username) || {};
    const source = [sourceRow.username, sourceRow.full_name, sourceRow.bio, sourceRow.external_url, ...(Array.isArray(sourceRow.posts) ? sourceRow.posts.map(p => typeof p === 'string' ? p : (p?.caption || p?.text || '')) : [])].join(' ');
    const sourceEvidence = factualEvidenceScore(summary, facts, evidenceQuotes, source);
    const hookEvidence = hooks.map(h => evidenceScore(h, source));
    const genericOnly = /^(?:В профиле\s+)?(?:помогает клиентам достигать своих целей|публикует советы по тренировкам и питанию|делится советами|эксперт в своей нише|занимается развитием личного бренда)[.!]?$/i.test(summary.trim());
    // Do not reject a useful translated summary merely because lexical overlap
    // with the original language is low. Only a truly generic note with no
    // source evidence is rejected. Such a profile gets a dedicated repair call
    // and, if necessary, an extractive fallback instead of pausing the job.
    if (genericOnly || sourceEvidence < 1) continue;
    const usableHooks = hooks.length === HOOK_COUNT && hookEvidence.every(score => score >= 1) ? hooks : [];

    const meta = {
      version: ENRICH_VERSION,
      model: model || null,
      summary_words: wordCount(summary),
      structured: true,
      visible_format: 'prose',
      evidence_score: sourceEvidence,
      hook_evidence: usableHooks.length ? hookEvidence : [],
      hook_count: usableHooks.length,
      hooks: usableHooks,
      hooks_pending: usableHooks.length !== HOOK_COUNT,
      facts,
      facts_count: facts.length,
      evidence_quotes: quoteEvidence(evidenceQuotes, source),
      created_at: new Date().toISOString()
    };
    meta.content_hash = summaryContentHash(summary, usableHooks);
    out.set(username, { summary, hooks: usableHooks, meta, facts, signals });
  }
  return out;
}

// Returns Map<username, {summary, hooks, meta}>. Callers must tolerate a missing
// entry — a model that skips a profile leaves it for a retry rather than
// silently recording an empty note.


function buildSummaryRepairPrompt(row, maxPosts, maxWords) {
  return `Создай заново только один внутренний конспект Lead Intelligence для профиля ниже. Предыдущий ответ не прошёл техническую проверку, поэтому сейчас важнее всего точность, простая структура и факты.

${profileForPrompt(row, maxPosts)}

Верни только JSON:
{"username":"${normalizeUser(row?.username)}","summary":"...","facts":["...","..."],"evidence_quotes":["...","..."]}

Правила:
- summary — 50–${maxWords} слов, если материала достаточно; если материала меньше, используй меньше, но не выдумывай.
- Можно писать на языке источника профиля. Не переводи факты ради прохождения проверки.
- Summary должен быть конкретным: кто человек, чем занимается/что предлагает, и 2–4 самые сильные детали из постов.
- Сохраняй цифры, сроки, названия программ, результаты, веса и другие конкретные данные точно.
- Не используй подписчиков и число постов.
- facts — 2–8 атомарных фактов.
- evidence_quotes — 2–5 коротких фрагментов ДОСЛОВНО из био/постов, без перевода. Каждый фрагмент должен реально подтверждать summary.
- Не пиши DM и не добавляй оффер отправителя.`;
}

function buildDenseRewritePrompt(row, maxPosts, maxWords) {
  return `Перепиши только summary для этого Instagram-профиля. Сейчас заметка слишком поверхностная.\n\n${profileForPrompt(row, maxPosts)}\n\nТребования:\n- Верни только JSON: {"results":[{"username":"...","summary":"..."}]}\n- summary начинается ровно с «В профиле».\n- Используй ВСЕ подтверждённые конкретные детали из био и подписей постов, которые относятся к человеку: цифры, сроки, результаты, названия программ, брендов, компаний, проектов, мероприятий, мест, профессий и конкретные темы.\n- Если подпись говорит «15 недель потеря 14 кг» и «13 недель в программе cut», это нужно сохранить как минимум отдельными конкретными фактами, а не сводить к «занимается фитнесом».\n- Не добавляй ничего, чего нет в источнике.\n- Не пиши имя, подписчиков и количество постов.\n- Не используй заголовки и списки.\n- Цель: насыщенная заметка примерно 60–${maxWords} слов, но если данных меньше — используй максимум реальной конкретики без выдумки.`;
}

export async function enrichProfiles(db, rows, options = {}) {
  const batch = rows.slice(0, options.batchSize || ENRICH_BATCH);
  if (batch.length === 0) return new Map();

  const agent = normalizeAgentContext(options.agentContext);
  const policy = agent.policy;
  const maxWords = 120; // fixed internal cap; not a user-facing AI Agent setting
  // The note is an internal document. By default it is written in Russian and
  // the DM is written in the recipient's language — mixing the two inside one
  // paragraph makes the model paraphrase Russian terms into the message.
  const summaryLang = policy.summaryLanguage === 'lead'
    ? (options.lang || batch[0].lang || 'ru')
    : 'ru';

  const systemPrompt = buildSystemPrompt({ summaryLang, maxWords });
  const maxPosts = options.maxPosts || 12;

  const reply = await callOpenRouter(
    db, systemPrompt, buildUserPrompt(batch, maxPosts),
    options.maxTokens || TOKENS_PER_PROFILE * batch.length,
    { ...(options.callOptions || {}), model: personalizationModel(db), reasoning: { effort: 'medium' }, responseFormat: ENRICH_RESPONSE_FORMAT }
  );

  const out = notesFromReply(reply, maxWords, options.model, batch);

  // A weak batched answer is retried per profile. This is deliberately also
  // done when the whole batch is empty: one malformed/truncated model response
  // must never become a job full of missing or "0 facts" notes.
  const missing = batch.filter(r => !out.get(normalizeUser(r.username))?.summary);
  const produced = [...out.values()].filter(v => v.summary).length;
  if (missing.length) {
    console.warn(
      `[ContactEnrich] модель пропустила ${missing.length} из ${batch.length} профилей, ` +
      'переспрашиваю по одному'
    );
    for (const row of missing.slice(0, options.maxSingleRetries ?? batch.length)) {
      try {
        const one = await callOpenRouter(
          db, systemPrompt, buildUserPrompt([row], maxPosts),
          SINGLE_PROFILE_TOKENS, { ...(options.callOptions || {}), model: personalizationModel(db), reasoning: { effort: 'medium' }, responseFormat: ENRICH_RESPONSE_FORMAT }
        );
        for (const [key, value] of notesFromReply(one, maxWords, options.model, [row])) {
          if (!out.get(key)?.summary) out.set(key, value);
        }
      } catch (e) {
        console.warn(`[ContactEnrich] повтор @${row.username} не удался: ${e.message}`);
      }
    }
  }


  // Final recovery pass for profiles that still have no usable summary. This is
  // intentionally simpler than the batch contract: fewer fields means fewer
  // ways for a perfectly good model answer to be rejected. The job must never
  // pause just because a batch JSON contract was brittle.
  for (const row of batch) {
    const key = normalizeUser(row.username);
    if (out.get(key)?.summary) continue;
    try {
      const repaired = await callOpenRouter(
        db,
        'Ты аккуратно создаёшь один внутренний конспект Instagram-профиля. Не выдумывай. Верни только JSON с username, summary, facts и evidence_quotes.',
        buildSummaryRepairPrompt(row, maxPosts, maxWords),
        Math.max(SINGLE_PROFILE_TOKENS, 2400),
        { ...(options.callOptions || {}), model: personalizationModel(db), reasoning: { effort: 'low' }, responseFormat: undefined }
      );
      const parsed = parseNotesReply(repaired);
      const candidate = parsed.find(x => normalizeUser(x?.username) === key) || parsed[0];
      if (candidate?.summary) {
        const candidateMap = notesFromReply(JSON.stringify({ results: [candidate] }), maxWords, options.model, [row]);
        const note = candidateMap.get(key);
        if (note) out.set(key, note);
      }
    } catch (e) {
      console.warn(`[ContactEnrich] summary repair @${row.username} failed: ${e.message}`);
    }
  }

  // A syntactically valid note can still be too thin. Give the model a second,
  // narrower rewrite task for those profiles instead of accepting a 10–20 word
  // generic summary. This pass is fed the raw scraped profile again, so it can
  // recover concrete numbers/names that the first composition ignored.
  for (const row of batch) {
    const key = normalizeUser(row.username);
    const current = out.get(key)?.summary || '';
    const sourceHasDetails = String(row.bio || '').length >= 20 || (Array.isArray(row.posts) && row.posts.some(p => String(p || '').trim().length >= 20));
    if (!sourceHasDetails) continue;
    if (wordCount(current) >= Math.min(60, Math.max(20, Math.round(maxWords * 0.5)))) continue;
    try {
      const rewrite = await callOpenRouter(
        db,
        systemPrompt,
        buildDenseRewritePrompt(row, maxPosts, maxWords),
        DENSE_REWRITE_TOKENS,
        { ...(options.callOptions || {}), model: personalizationModel(db) }
      );
      const parsed = parseNotesReply(rewrite);
      const candidate = parsed.find(x => normalizeUser(x?.username) === key) || parsed[0];
      const summary = String(candidate?.summary || '').replace(/\s+/g, ' ').trim();
      const source = sourceTextForRow(row);
      const evidence = evidenceScore(summary, source);
      if (/^В профиле\b/i.test(summary) && wordCount(summary) >= wordCount(current) && evidence >= 2) {
        out.set(key, {
          ...(out.get(key) || { hooks: [], meta: {} }),
          summary: clampWords(summary, maxWords),
          meta: { ...(out.get(key)?.meta || {}), version: ENRICH_VERSION, summary_words: wordCount(summary), evidence_score: evidence, content_hash: summaryContentHash(summary, out.get(key)?.hooks || []), dense_rewrite: true, created_at: new Date().toISOString() }
        });
      }
    } catch (e) {
      console.warn(`[ContactEnrich] dense rewrite @${row.username} failed: ${e.message}`);
    }
  }

  // Repair only the missing hook layer. Never discard a valid summary because
  // the model formatted one of the three short hooks badly.
  for (const row of batch) {
    const key = normalizeUser(row.username);
    const current = out.get(key);
    if (!current?.summary || current.hooks?.length === HOOK_COUNT) continue;
    try {
      const hookReply = await callOpenRouter(
        db,
        'Ты извлекаешь только 3 коротких подтверждённых повода для персонализации из профиля Instagram. Не выдумывай. Верни только JSON.',
        `${profileForPrompt(row, maxPosts)}\n\nВерни ровно: {\"hooks\":[\"5-7 слов\",\"5-7 слов\",\"5-7 слов\"]}. Каждый hook должен быть подтверждён текстом профиля и отличаться от двух других.`,
        900,
        { ...(options.callOptions || {}), model: personalizationModel(db), reasoning: { effort: 'low' }, responseFormat: { type: 'json_schema', json_schema: { name: 'lead_hooks', strict: true, schema: { type: 'object', additionalProperties: false, properties: { hooks: { type: 'array', items: { type: 'string' } } }, required: ['hooks'] } } } }
      );
      const parsed = JSON.parse(String(hookReply).replace(/^```json\s*|\s*```$/gi, '').trim());
      const repaired = normalizeHooks(parsed?.hooks);
      const source = [row.username, row.full_name, row.bio, row.external_url, ...(Array.isArray(row.posts) ? row.posts.map(p => typeof p === 'string' ? p : (p?.caption || p?.text || '')) : [])].join(' ');
      if (repaired.length === HOOK_COUNT && repaired.every(h => evidenceScore(h, source) >= 1)) {
        current.hooks = repaired;
        current.meta = { ...current.meta, hooks: repaired, hooks_pending: false, hook_count: repaired.length, hook_evidence: repaired.map(h => evidenceScore(h, source)), content_hash: summaryContentHash(current.summary, repaired) };
      }
    } catch (e) {
      console.warn(`[ContactEnrich] hook repair @${row.username} failed: ${e.message}`);
    }
  }

  // Last-resort deterministic grounding. It is deliberately extractive: if the
  // model/provider is unavailable, we still store a truthful note built from the
  // exact bio/captions rather than surfacing a red error and losing the profile.
  for (const row of batch) {
    const key = normalizeUser(row.username);
    if (out.get(key)?.summary) continue;
    const fallback = buildFallbackSummary(row, maxWords);
    if (!fallback) continue;
    const meta = {
      version: ENRICH_VERSION,
      model: personalizationModel(db),
      summary_words: wordCount(fallback),
      structured: false,
      fallback: 'extractive',
      visible_format: 'prose',
      evidence_score: evidenceScore(fallback, sourceTextForRow(row)),
      hook_count: 0,
      hooks: [],
      hooks_pending: true,
      created_at: new Date().toISOString()
    };
    meta.content_hash = summaryContentHash(fallback, []);
    out.set(key, { summary: fallback, hooks: [], meta, facts: [], signals: [] });
  }

  return out;
}

export { wordCount, normalizeSummary, buildFallbackSummary, factualEvidenceScore };
