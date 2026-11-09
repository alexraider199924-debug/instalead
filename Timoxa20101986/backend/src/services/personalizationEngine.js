// ---------------------------------------------------------------------------
// Personalization engine.
//
// One place where a DM opener is built, judged and retried. The previous code
// had three near-identical generators with three drifting prompt bodies and a
// guardrail array that was declared and never used; the business context read
// from ai_business_context stopped at the route and never reached the model.
//
// The order below is the order a message travels:
//   business context -> profile intelligence -> prompt -> quality gate -> retry.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { callOpenRouter, isValidModelId } from './aiService.js';
import { parseFirstName } from './nameParser.js';
import { normalizeAgentContext, policyInstructions } from './offerContext.js';
import { ENRICH_VERSION } from './contactEnrichService.js';

function personalizationModel(db) {
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_model'").get()?.value;
  const candidate = String(saved || '').trim();
  return isValidModelId(candidate) ? candidate : 'anthropic/claude-sonnet-4';
}

// The guardrails that were previously declared but unused. They constrain the
// model, and the quality gate re-checks the two that are mechanically testable.
const STANDARDS = [
  'Используй только подтверждённые данные из контекста бизнеса и профиля лида. Ничего не выдумывай.',
  'Не выдавай отправителя за другого человека и не создавай впечатление личного знакомства.',
  'Не скрывай коммерческий характер предложения и сохраняй смысл оффера и CTA из шаблона.',
  'Используй одну-две подтверждённые детали из Lead Intelligence. Если пригодной детали нет, не имитируй знакомство.',
  'Если шаблон содержит обман, давление или просьбу обойти правила платформы, не усиливай это.',
  'Верни только готовый текст сообщения: 2-4 коротких предложения, без эмодзи (если их нет в шаблооне) и без длинного тире.'
];

// Phrases that make a DM read as automated. Enforced after generation, because
// listing them in the prompt alone reliably leaks through anyway.
const BANNED_OPENERS = [
  'hi there', 'hey there', 'hello there',
  'hi friend', 'hey friend', 'hello friend'
];

const BANNED_PHRASES = [
  'i love what you do', 'your content is amazing', "you're incredible",
  'love your content', 'just wanted to reach out', 'saw your profile',
  'seemed interesting', 'caught my eye', 'love what you see',
  'мне нравится твой контент', 'понравились твои посты', 'заинтересовал твой профиль',
  'хотел написать', 'увидел твой профиль'
];

const LANG_NAMES = {
  ru: 'русском', en: 'английском', es: 'испанском', de: 'немецком',
  fr: 'французском', it: 'итальянском', pt: 'портагальском', nl: 'нидерландском',
  pl: 'польском', tr: 'турецком', ar: 'арабском', hi: 'хинди'
};

const DEFAULT_LANG = 'en';

function pickLang(...candidates) {
  for (const code of candidates) {
    if (code && LANG_NAMES[code]) return code;
  }
  return DEFAULT_LANG;
}

// ---------------------------------------------------------------------------
// Business context
// ---------------------------------------------------------------------------

// The field contract, defaults and prompt wording all live in offerContext.js.
// This function is only the name the rest of the codebase already imports; it
// stays so existing call sites keep working while returning the richer,
// policy-aware shape.
export function buildBusinessContext(agentContext) {
  return normalizeAgentContext(agentContext);
}

function trim(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Profile intelligence
// ---------------------------------------------------------------------------

// The previous implementation detected topics with Russian-and-English-only
// regexes, so a Spanish fitness lead produced no insight at all. These cover
// the six supported languages for the categories that actually drive a hook.
const TOPIC_KEYWORDS = {
  fitness: /\b(gym|workout|work out|fitness|trainer|training|run|running|marathon|crossfit|yoga|gimnasio|entrenamiento|fitness|gymnasium|entrainement|palestra|allenamento)\b|фитнес|трениров|спорт|качок|зал/i,
  food: /\b(food|recipe|cook|cooking|bakery|chef|restaurant|eating|vegetarian|cocina|receta|gourmet|küche|rezept|cucina|ricetta)\b|еда|рецепт|готов|кухн/i,
  travel: /\b(travel|trip|adventure|journey|explore|tourism|viaje|aventura|reise|abenteuer|viaggio)\b|путеш|туризм/i,
  business: /\b(business|entrepreneur|startup|founder|agency|business|agency|emprendedor|negocio|gruender|unternehmen|imprenditore)\b|бизнес|предпринимат|стартап/i,
  beauty: /\b(beauty|makeup|skincare|cosmetic|hair|nail|spa|belleza|maquillaje|piel|beauty|makeup|haarpflege|makeup|beauty)\b|красот|макияж|космет/i,
  tech: /\b(tech|technology|software|app|developer|coding|saas|tecnologia|software|technologie|software)\b|технолог|разработ/i,
  creator: /\b(content|creator|vlogger|youtube|blogger|influencer|tiktok|reels|creador|contenido|content)\b|блог|влогер|контент/i,
  family: /\b(family|mama|mom|mother|дети|семья|мама|мать)\b/,
  fashion: /\b(fashion|style|outfit|clothing|moda|ropa|moda|kleidung)\b|мода|стиль|одежд/i,
  auto: /\b(auto|cars|car|driving|motorsport|авто|машин|автомобил)\b/
};

const AUDIENCE_BANDS = [
  [100000, 'крупный инфлюенсер (100k+)'],
  [50000, 'мега-блогер (50k+)'],
  [10000, 'микро-инфлюенсер (10k+)'],
  [1000, 'растущий контент-мейкер (1k+)'],
  [0, 'активный пользователь']
];

export function buildProfileIntelligence(profileData, lead) {
  const pd = profileData || {};
  const posts = Array.isArray(pd.posts) ? pd.posts.filter(Boolean) : [];
  const bio = String(pd.bio || lead?.bio || '').trim();

  // The note produced by contact enrichment. When it exists it is the whole
  // point of the two-stage design: the model already read this profile once,
  // paid for it, and wrote down what actually matters. Re-deriving themes with
  // the keyword tables below would throw that away and replace a considered
  // read with regex buckets.
  const summary = String(lead?.profile_summary || '').trim();
  const meta = readSummaryMeta(lead?.profile_summary_meta);

  // Hooks only exist from ENRICH_VERSION 2 onward, and a note written by an
  // older prompt version was graded against a different idea of what a hook
  // is. Using its (absent or differently-shaped) hooks would silently degrade
  // the message, so they are ignored rather than guessed at.
  const hooks = meta.version === ENRICH_VERSION && Array.isArray(meta.hooks)
    ? meta.hooks.filter(h => typeof h === 'string' && h.trim().length > 2).slice(0, 3)
    : [];

  const facts = [];
  const hooksBlock = [];

  if (summary) {
    facts.push(`КОНСПЕКТ ПРОФИЛЯ (подготовлен заранее, это главный источник):\n${trim(summary, 700)}`);
  }

  if (bio) facts.push(`БИО: ${trim(bio, 300)}`);

  const found = new Set();
  for (const post of [...posts, bio].slice(0, 12)) {
    for (const [topic, re] of Object.entries(TOPIC_KEYWORDS)) {
      if (re.test(post)) found.add(topic);
    }
  }
  // Themes inferred by keyword matching are a weak signal next to a written
  // summary, and they are actively harmful when they contradict it (a
  // "fitness" account that sells courses for finance). Shown only as a hint.
  if (found.size && !summary) facts.push(`ТЕМЫ КОНТЕНТА: ${[...found].join(', ')}`);

  const followers = Number(pd.followers) || 0;
  // Follower count is intentionally excluded from the model context: it is not
  // a personalization fact and used to leak into DMs despite the prompt ban.


  if (lead?.niche) facts.push(`НИША: ${trim(lead.niche, 120)}`);

  // One verbatim line from the profile is worth more to the model than any
  // summary of it, because it is the only part it cannot paraphrase into a
  // generic compliment.
  if (hooks.length) {
    hooksBlock.push(`ТРИ КРЮЧКА — конкретные зацепки, отобранные из этого профиля. Возьми ОДИН и начни с него своими словами:\n${hooks.map((h, i) => `${i + 1}. ${trim(h, 90)}`).join('\n')}\nНе используй два сразу — это перечисление, а не личное обращение.`);
  }

  if (summary) {
    hooksBlock.push('ОПИРАЙСЯ НА КОНСПЕКТ ВЫШЕ. Бери оттуда конкретные детали и вплетай их в оффер. Не пересказывай конспект целиком и не перечисляй факты списком.');
  } else if (posts.length) {
    hooksBlock.push(`ДОСТУПНЫЕ ЦИТАТЫ ИЗ ПРОФИЛЯ (используй максимум одну, своими словами):\n${posts.slice(0, 3).map((p, i) => `${i + 1}. ${trim(p, 180)}`).join('\n')}`);
  } else if (bio) {
    hooksBlock.push(`ЕДИНСТВЕННАЯ ДОСТУПНАЯ ДЕТАЛЬ — БИО: ${trim(bio, 300)}\nЕсли из неё нельзя вывести честный повод для личного сообщения, напиши нейтральное сообщение БЕЗ имитации знакомства.`);
  } else {
    hooksBlock.push('ДАННЫХ О ПРОФИЛЕ НЕТ. Пиши нейтральное сообщение от лица бизнеса. НЕ придумывай интересы, посты, профессию и общие интересы.');
  }

  return {
    text: facts.length ? facts.join('\n') : '',
    hooks: hooksBlock.join('\n\n'),
    hasAnyData: Boolean(summary || bio || posts.length),
    // The grounding check below used to require a verbatim post quote, which
    // made a well-personalized message fail whenever enrichment had run and
    // the raw posts were no longer in hand. It now accepts the summary.
    summary,
    hooksList: hooks,
    topics: [...found],
    quotes: posts.slice(0, 3).map(p => trim(p, 180)).filter(Boolean),
    followers,
    evidenceQuality: meta.evidence_score >= 3 || (hooks.length === 3 && summary.length > 80) ? 'strong' : (summary || bio || posts.length ? 'weak' : 'none')
  };
}

function readSummaryMeta(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getAgentVersion(agentContext) {
  const map = normalizeAgentContext(agentContext)?.map || {};
  return Number(map.agent_version || 1);
}

export function getSummaryVersion(lead) {
  const meta = readSummaryMeta(lead?.profile_summary_meta);
  return Number(meta.version || 0);
}

export function personalizationIsReady({ lead, agentContext }) {
  return Boolean(String(lead?.profile_summary || '').trim()) && getSummaryVersion(lead) > 0 && Boolean(getAgentVersion(agentContext));
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const STYLE_DIRECTIVES = {
  friendly: 'Тон тёплый и доброжелательный, но сдержанный.',
  neutral: 'Тон естественный и нейтральный.',
  business: 'Тон деловой, конкретный, без сюсюканья.',
  custom: ''
};

export function buildPrompt({ businessContext, intel, template, lead, lang, style, customPrompt }) {
  const langName = LANG_NAMES[lang] || 'английском';
  const policy = businessContext?.policy || { opening: 'profile_first', greeting: 'name', tone: 'neutral' };

  // A campaign may override the agent's tone with its own style. An explicit
  // custom instruction always wins. Otherwise the AI Agent's own voice wins:
  // campaigns store personalization_style='neutral' by default, and letting
  // that default through appended "тон нейтральный" to every prompt even when
  // the sender had described a specific voice in the AI Agent tab — the agent's
  // voice was collected and then diluted back into nothing.
  const agentHasVoice = Boolean(businessContext?.policy?.hasStyle);
  const campaignStyleText = style === 'custom'
    ? trim(customPrompt, 500)
    : STYLE_DIRECTIVES[style] || '';
  const styleText = style === 'custom'
    ? campaignStyleText
    : (agentHasVoice ? '' : campaignStyleText);

  // The contact's saved name is authoritative for personalization. Never infer a greeting name from an Instagram username.
  const firstName = parseFirstName(lead?.contact_name || lead?.full_name, '') || '';

  const sampleMode = businessContext?.sampleMode || 'offer_template';
  const variation = businessContext?.sampleVariation || 'none';
  const sampleRules = businessContext?.sample
    ? (sampleMode === 'offer_template'
      ? `ОСОБЫЙ РЕЖИМ: КАНОНИЧЕСКИЙ ОФФЕР. Это обязательная основа готового DM, а не пример для свободного копирайтинга.
1) Сохрани смысл, намерение, порядок мысли и CTA исходного оффера.
2) Разрешено изменить только отдельные слова/связки в пределах выбранной вариативности и вставить ОДНУ конкретную деталь из профиля.
3) НЕ используй поля «проблема», «результат», «proof», «как это работает», «почему сейчас» или «структура сообщения» для создания нового sales pitch. Они являются справочной информацией бизнеса и НЕ заменяют канонический оффер.
4) НЕ добавляй презентацию компании, цифры, кейсы, преимущества или объяснение продукта, если этого нет в каноническом оффере.
5) Если в оффере есть {first_name}, обязательно подставь имя из Contacts.
6) Первое обращение ОБЯЗАТЕЛЬНО: используй приветствие из канонического оффера (например, Yo/Hey/Hi) + имя из Contacts. Если канонический оффер не содержит приветствия, добавь короткое естественное «Hi {first_name},» перед ним.
7) Персонализация должна быть короткой вставкой, а не новым первым абзацем.
Вариативность: ${variation === 'none' ? 'минимальная — держись максимально близко к исходной формулировке.' : variation === 'light' ? 'лёгкая — можно немного менять слова и связки, но не менять смысл, CTA и длину конструкции.' : 'spintax — разрешены варианты только там, где смысл не меняется; используй формат {вариант 1|вариант 2}. Не спинтай имя и факты о лиде.'}`
      : `ПРИМЕР — ТОЛЬКО ОБРАЗЕЦ СТИЛЯ. Не копируй его оффер и структуру дословно; используй его для манеры, длины и степени прямоты.`)
    : '';

  const systemPrompt = `Ты пишешь первые DM в Instagram от лица компании. Твоё сообщение прочитает живой человек и решит за секунды, отвечать ли ему.

ПИШИ СТРОГО НА ${langName.toUpperCase()} ЯЗЫКЕ.

ТВОЯ ГЛАВНАЯ ЗАДАЧА: персонализировать заданную отправителем основу, а не придумывать новый оффер. Если отправитель дал пример сообщения как основу оффера, это главный источник смысла. AI должна сделать его более личным, а не переписать бизнес-стратегию.

ЧТО ДЕЛАЕТ ХОРОШЕЕ СООБЩЕНИЕ:
- ВСЕГДА обращайся по имени из Contacts. Никогда не используй username как имя.
- ВСЕГДА начинай сообщение с короткого приветствия + имени.
- Используй одну конкретную подтверждённую деталь из профиля; не выдумывай боль
- В режиме «основа оффера» сохраняй канонический оффер, а персонализацию делай короткой вставкой
- Не превращай короткий DM в презентацию компании
- Заканчивай тем же типом простого вопроса/CTA, который задан каноническим оффером
- Не ориентируйся на искусственный лимит символов: длину задаёт сам оффер

ЖЁСТКИЕ ПРАВИЛА:
- Никаких выдуманных проблем лида. Opportunity можно сформулировать только как гипотезу, если она следует из профиля.
- Не упоминай подписчиков как персонализацию.
- Не добавляй proof, цифры, кейсы или услуги, которых нет в исходном оффере, если режим основы оффера не требует их.
- Если данных о профиле мало — персонализируй только тем, что подтверждено.
- Если задана основа оффера, НЕ заменяй её своим длинным коммерческим текстом.
${sampleRules ? `\n${sampleRules}` : ''}
${businessContext?.guardrails ? `\nЗАПРЕТЫ ОТПРАВИТЕЛЯ (нарушение — ошибка):\n${businessContext.guardrails}` : ''}

${STANDARDS.map((s, i) => `${i + 1}. ${s}`).join('\n')}

СТРУКТУРА СООБЩЕНИЯ: ${sampleMode === 'offer_template' ? 'Не применять отдельную структуру; следовать каноническому офферу.' : (businessContext?.policy?.messageStructure || '1. Personalization\n2. Offer\n3. CTA')}
Сначала определи personalization_hook, relevant_problem, offer_angle и cta. Верни только валидный JSON без markdown в формате {\"personalization_hook\":\"...\",\"relevant_problem\":\"...\",\"offer_angle\":\"...\",\"cta\":\"...\",\"final_message\":\"...\"}. Поле final_message должно быть готовым DM.`;

  const sections = [
    `ЯЗЫК: ${langName}`,
    (businessContext?.offer && sampleMode !== 'offer_template') ? `ЧТО МЫ ПРЕДЛАГАЕМ:\n${businessContext.offer}` : '',
    businessContext?.style ? `КАК ГОВОРИТ ОТПРАВИТЕЛЬ:\n${businessContext.style}` : '',
    intel?.text ? `ЧТО ИЗВЕСТНО О ПОЛУЧАТЕЛЕ:\n${intel.text}` : '',
    intel?.hooks ? `ОПОРЫ ДЛЯ ПЕРСОНАЛЬНОГО ПОВОДА:\n${intel.hooks}` : '',
    `ПОЛУЧАТЕЛЬ:\nUsername: @${lead?.username || 'unknown'}\nИмя: ${firstName || 'не указано'}`,
    styleText ? `ДОПОЛНИТЕЛЬНЫЙ СТИЛЬ ОТПРАВИТЕЛЯ:\n${styleText}` : '',
    policyInstructions(policy).map(r => `- ${r}`).join('\n'),
    (businessContext?.sample && businessContext?.sampleMode === 'offer_template')
      ? `КАНОНИЧЕСКАЯ ОСНОВА СООБЩЕНИЯ ИЗ AI AGENT: ${trim(businessContext.sample, 600)}`
      : (template ? `ОСНОВА СООБЩЕНИЯ КАМПАНИИ: ${trim(template, 600)}` : (businessContext?.sample ? `ПРИМЕР СТИЛЯ ИЗ AI AGENT: ${trim(businessContext.sample, 600)}` : '')),
    'Верни только JSON указанного формата. Не добавляй пояснения, markdown или отдельный текст вне JSON.'
  ].filter(Boolean);

  return { systemPrompt, userPrompt: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

// Returns a list of human-readable problems. Empty means the message passed.
// A failed gate does not discard the message — it feeds the problems back so
// the next attempt fixes exactly what was wrong.
export function runQualityGate({ text, lang, intel, template, businessContext, generated = null, lead = {} }) {
  const issues = [];
  const body = String(text || '').trim();

  if (!body) {
    issues.push('сообщение пустое');
    return issues;
  }

  const policy = businessContext?.policy || { greeting: 'name' };

  if (generated && generated.validJson === false) issues.push('модель не вернула требуемый JSON-пакет');
  {
    const firstName = parseFirstName(lead?.contact_name || lead?.full_name, '') || '';
    if (firstName) {
      const escaped = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`^(?:yo|hey|hi|hello|hola|bonjour|ciao|hallo)\\s+${escaped}\\b`, 'i').test(body)) {
        issues.push(`сообщение должно начинаться с приветствия и имени ${firstName}`);
      }
    } else {
      issues.push('у контакта нет сохранённого имени — нельзя генерировать персонализированный DM');
    }
  }
  if (generated && !String(generated.personalization_hook || '').trim() && intel?.hasAnyData && intel?.evidenceQuality === 'strong') issues.push('не выбран конкретный персональный повод из Lead Intelligence');

  const lower = body.toLowerCase();
  const openerHit = BANNED_OPENERS.find(p => lower.startsWith(p));
  if (openerHit) {
    issues.push(policy.greeting === 'name'
      ? `начинается с шаблонного «${openerHit}», хотя по настройке нужно начать с имени`
      : `начинается с шаблонного «${openerHit}»`);
  }

  const phraseHit = BANNED_PHRASES.find(p => lower.includes(p));
  if (phraseHit) issues.push(`содержит шаблонную фразу «${phraseHit}»`);

  if (/—/.test(body)) issues.push('использовано длинное тире');

  // The one check that actually distinguishes personalization from a mail merge:
  // material from the profile has to survive into the message. Grounding is
  // checked against the HOOKS first when they exist: three fragments of five
  // to seven words are a far sharper target than 90 words of prose, so a
  // message that reaches for a general sentence ("эксперт в своей нише") is
  // rejected while one that reaches for "разбирает чужие ошибки в забегах"
  // passes. Exact word matching is unusable as the primary test — Russian
  // inflects, and "разбирает" shares no equal token with "разбор" — hence the
  // character n-grams, loose on purpose because a false accept sends a slightly
  // generic message while a false reject burns a paid retry.
  if (intel?.hasAnyData) {
    const hooked = (intel.hooksList || []).some(h => sharedGrams(h, body, 5) >= 2);
    const grounded = hooked
      || (intel.summary && sharedGrams(intel.summary, body, 5) >= 2)
      || (intel.quotes.length && intel.quotes.some(q => overlap(q, body) >= 0.28))
      || (!intel.summary && intel.text && sharedWordCount(intel.text, body) >= 2);
    if (intel.evidenceQuality === 'weak') {
      // Sparse profiles are allowed to produce a neutral DM; forcing a hook here
      // would reward hallucination rather than personalization.
    }
    if (!grounded) {
      issues.push(hooked || intel.summary
        ? 'сообщение не опирается на конспект профиля — это шаблон'
        : 'нет ни одной конкретной детали из профиля — это шаблон');
    }
  }

  // The mirror failure: the model handing back the campaign template with a
  // name dropped in. Cheap to detect and the reason most cold DMs feel mass-
  // produced, so it is checked explicitly rather than inferred from the
  // personalization check above.
  const referenceMessage = (businessContext?.sample && businessContext?.sampleMode === 'offer_template')
    ? businessContext.sample
    : (template || businessContext?.sample || '');
  const sampleMode = businessContext?.sampleMode || 'offer_template';
  if (referenceMessage && sampleMode === 'offer_template') {
    const ref = String(referenceMessage).replace(/\{first_name\}/gi, firstNameForGate(lead));
    const refOverlap = overlap(ref, body);
    const refWords = tokens(ref).length;
    const minimumOverlap = refWords <= 20 ? 0.45 : 0.35;
    if (refWords >= 6 && refOverlap < minimumOverlap) {
      issues.push(`сообщение слишком далеко ушло от канонического оффера (совпадение ${Math.round(refOverlap * 100)}%, нужно не меньше ${Math.round(minimumOverlap * 100)}%)`);
    }
  }
  if (referenceMessage && sampleMode !== 'offer_template' && overlap(referenceMessage, body) >= 0.85 && body.length >= 0.75 * String(referenceMessage).length) {
    issues.push(template
      ? 'сообщение почти дословно повторяет шаблон — это не персонализация'
      : 'сообщение почти дословно повторяет пример стиля — перепиши содержание под лида');
  }

  if (referenceMessage && sampleMode === 'offer_template' && intel?.hasAnyData && intel?.evidenceQuality === 'strong') {
    const personalized = String(generated?.personalization_hook || '').trim();
    if (!personalized) issues.push('режим основы оффера требует отдельный персональный повод');
  }

  // A DM with no ask is a DM with no reason to reply, which is the one thing
  // this system exists to prevent. Either it asks something, or the intent of
  // the configured CTA survived into the text — the same n-gram test used for
  // grounding, because "скиньте профиль" has to be allowed to answer "скиньте
  // профиль в директ". A keyword list was tried first and accepted any message
  // containing the word "интересно", which is not an ask.
  const cta = String(businessContext?.map?.offer_cta || '').trim();
  if (cta) {
    const asksSomething = /[?？]/.test(body) || sharedGrams(cta, body, 4) >= 1;
    if (!asksSomething) {
      issues.push('нет призыва к действию — добавь один простой вопрос из блока «ЧТО ПРОСИМ В ОТВЕТ»');
    }
  }

  if (!/[.!?]/.test(body)) issues.push('нет знака конца предложения');

  return issues;
}

function firstNameForGate(lead) {
  return parseFirstName(lead?.contact_name || lead?.full_name, '') || '';
}

function tokens(value) {
  return String(value || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function overlap(source, target) {
  const a = new Set(tokens(source));
  if (!a.size) return 0;
  let hit = 0;
  for (const w of new Set(tokens(target))) if (a.has(w)) hit++;
  return hit / a.size;
}

function sharedWordCount(source, target) {
  const a = new Set(tokens(source));
  let hit = 0;
  for (const w of new Set(tokens(target))) if (a.has(w)) hit++;
  return hit;
}

// Distinct n-grams shared between two texts. Character-based rather than
// word-based on purpose: it has to work for Russian inflection and for
// languages this system does not model at all.
function sharedGrams(source, target, n) {
  const grams = new Set();
  for (const word of tokens(source)) {
    if (word.length < n) continue;
    for (let i = 0; i + n <= word.length; i++) grams.add(word.slice(i, i + n));
  }
  if (!grams.size) return 0;
  let hit = 0;
  for (const word of new Set(tokens(target))) {
    if (word.length < n) continue;
    for (let i = 0; i + n <= word.length; i++) {
      if (grams.has(word.slice(i, i + n))) { hit++; break; }
    }
  }
  return hit;
}

const LANGUAGE_HINTS = {
  fr: ['le','la','les','des','une','dans','pour','avec','sur','est','sont','que','qui','vous','nous','être','avoir','pas','bonjour','votre','avec','mais'],
  it: ['il','lo','la','gli','le','una','uno','dei','delle','con','per','che','sono','questa','questo','non','come','ciao','vostro','vostra'],
  pt: ['o','a','os','as','um','uma','dos','das','para','com','que','não','você','vocês','são','uma','mais','olá','seu','sua'],
  es: ['el','la','los','las','un','una','para','con','que','por','del','es','son','como','este','esta','más','también','hola','tu','tus'],
  de: ['der','die','das','ein','eine','und','mit','für','von','ist','sind','nicht','ich','du','sie','auf'],
  en: ['the','and','for','with','from','this','that','is','are','you','your','about','have','has','not'],
  nl: ['de','het','een','en','van','voor','met','zijn','niet','dat','die','op','je','jij','naar'],
  pl: ['jest','są','nie','dla','oraz','przez','jak','który','która','ten','ta','to','się','czy','z'],
  tr: ['ve','bir','bu','için','ile','olan','değil','nasıl','daha','çok','ben','sen','sizin'],
  ar: ['ال','و','في','من','على','مع','هذا','هذه','هو','هي','أن','ما','لا'],
  hi: ['और','का','की','के','में','से','को','पर','यह','है','हैं','नहीं','एक','आप']
};

export function detectLangCode(text) {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return 'en';
  if (/[\u0600-\u06ff]/.test(value)) return 'ar';
  if (/[\u0900-\u097f]/.test(value)) return 'hi';
  if (/[а-яё]/.test(value)) return 'ru';

  const words = value.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean);
  const counts = Object.fromEntries(Object.keys(LANGUAGE_HINTS).map(k => [k, 0]));
  for (const [lang, hints] of Object.entries(LANGUAGE_HINTS)) {
    for (const w of words) if (hints.includes(w)) counts[lang]++;
  }

  // Distinctive letters are only tie-breakers. French/Italian/Spanish/Portuguese
  // all share é/á/í/ó/ú, so accents must never be the primary classifier.
  if (/[ãõ]/.test(value)) counts.pt += 3;
  if (/[ñ¿¡]/.test(value)) counts.es += 3;
  if (/[œ]/.test(value)) counts.fr += 3;
  if (/[ß]/.test(value)) counts.de += 3;
  if (/[ç]/.test(value)) { counts.fr += 1; counts.pt += 1; }
  if (/[àèìòù]/.test(value)) { counts.it += 1; counts.fr += 1; }

  const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return 'en';
  if (ranked[0][1] === ranked[1][1] && ranked[0][1] < 2) return 'en';
  return ranked[0][0];
}

function parseGeneratedPackage(raw) {
  const text = String(raw || '').trim();
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [stripped];
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && String(parsed.final_message || '').trim()) {
        return {
          personalization_hook: String(parsed.personalization_hook || '').trim(),
          relevant_problem: String(parsed.relevant_problem || '').trim(),
          offer_angle: String(parsed.offer_angle || '').trim(),
          cta: String(parsed.cta || '').trim(),
          final_message: String(parsed.final_message || '').trim(),
          validJson: true
        };
      }
    } catch {}
  }
  return { personalization_hook: '', relevant_problem: '', offer_angle: '', cta: '', final_message: text, validJson: false };
}

export { parseGeneratedPackage };

function bodyLanguageConfident(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 5;
}

function ensureCanonicalGreeting(text, firstName, sample, lang) {
  const body = String(text || '').trim();
  if (!firstName || !body) return body;
  const cleanName = String(firstName).trim();
  const greetingMatch = String(sample || '').trim().match(/^(yo|hey|hi|hello|hola|bonjour|ciao|hallo)\s*\{first_name\}\s*[,!:-]?/i);
  const greeting = greetingMatch?.[1] || ({fr:'Bonjour',es:'Hola',de:'Hallo',ru:'Привет',nl:'Hoi'}[lang] || 'Hi');
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const greetingPrefix = new RegExp(`^(?:yo|hey|hi|hello|hola|bonjour|ciao|hallo)\\s+${escaped}\\s*[,!:-]?\\s*`, 'i');
  if (greetingPrefix.test(body)) return body.replace(greetingPrefix, `${greeting} ${cleanName}, `).trim();
  const nameOnly = new RegExp(`^${escaped}\\s*[,!:-]?\\s*`, 'i');
  if (nameOnly.test(body)) return body.replace(nameOnly, `${greeting} ${cleanName}, `).trim();
  return `${greeting} ${cleanName}, ${body}`.replace(/\s+/g, ' ').trim();
}

function buildStrictOfferFallback(sample, firstName, hook) {
  const name = String(firstName || '').trim();
  let base = String(sample || '').trim().replace(/\{first_name\}/gi, name);
  if (!name) return base;
  const greetingMatch = String(sample || '').trim().match(/^(yo|hey|hi|hello|hola|bonjour|ciao|hallo)\s*\{first_name\}\s*[,!:-]?\s*/i);
  const greeting = greetingMatch?.[1] || 'Hi';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^(?:yo|hey|hi|hello|hola|bonjour|ciao|hallo)\\s+${escaped}\\s*[,!:-]?\\s*`, 'i');
  const normalizedBase = prefix.test(base) ? base.replace(prefix, `${greeting} ${name}, `) : `${greeting} ${name}, ${base.replace(new RegExp(`^${escaped}\\s*[,!:-]?\\s*`, 'i'), '')}`;
  if (!hook) return normalizedBase.trim();
  const cleanHook = hook.replace(/^[-–—•\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!cleanHook) return normalizedBase.trim();
  const rest = normalizedBase.replace(new RegExp(`^(?:yo|hey|hi|hello|hola|bonjour|ciao|hallo)\\s+${escaped}\\s*[,!:-]?\\s*`, 'i'), '');
  const hookSentence = /[.!?]$/.test(cleanHook) ? cleanHook : `${cleanHook}.`;
  return `${greeting} ${name}, ${hookSentence} ${rest}`.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const ATTEMPTS = 2;

// Personalization model is now configurable via DB settings (openrouter_model)
// instead of hardcoded. This allows using cheaper models like Gemini or GPT-4o-mini.

export async function generatePersonalizedMessage(db, {
  messageTemplate = '',
  lead = {},
  profileData = null,
  agentContext = [],
  style = 'neutral',
  customPrompt = '',
  extraInstruction = '',
  lang,
  maxTokens = 1400
}) {
  const businessContext = buildBusinessContext(agentContext);
  const intel = buildProfileIntelligence(profileData, lead);

  // The contact name is the single source of truth for greetings. Keep it in
  // this orchestration scope because it is also needed after generation by
  // ensureCanonicalGreeting(). Previously it existed only inside buildPrompt(),
  // so the preview/send pipeline crashed with `firstName is not defined`.
  const firstName = parseFirstName(lead?.contact_name || lead?.full_name, '') || '';

  // Language precedence: explicit call > the AI Agent's language setting when
  // it is not "auto" > whatever language the message template is written in.
  // "auto" means "match the recipient", which is the mode-language detector
  // already approximates — guessing from a Russian template used to force
  // Russian onto a Spanish account whose profile is entirely Spanish.
  const configured = businessContext?.policy?.language;
  const profileLanguageSource = [
    profileData?.bio,
    ...(Array.isArray(profileData?.posts) ? profileData.posts.slice(0, 5) : []),
    lead?.bio
  ].filter(Boolean).join(' ');
  const targetLang = pickLang(
    lang,
    configured && configured !== 'auto' ? configured : undefined,
    configured === 'auto' ? detectLangCode(profileLanguageSource) : undefined,
    detectLangCode(messageTemplate)
  );

  const { systemPrompt, userPrompt } = buildPrompt({
    businessContext, intel, template: messageTemplate, lead, lang: targetLang, style, customPrompt
  });

  const basePrompt = extraInstruction ? `${userPrompt}\n\nДОПОЛНИТЕЛЬНАЯ ИНСТРУКЦИЯ: ${trim(extraInstruction, 300)}` : userPrompt;

  let lastIssues = [];
  let text = '';
  let lastGenerated = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const prompt = attempt === 0 || !lastIssues.length
      ? basePrompt
      : `${basePrompt}\n\nПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА ПРОВЕРКУ:\n- ${lastIssues.join('\n- ')}\n\nИсправь эти проблемы. Сохрани требуемый JSON-формат и верни полный JSON-пакет заново.`;

    const raw = await callOpenRouter(db, systemPrompt, prompt, Math.max(maxTokens, 1400), { model: personalizationModel(db) });
    const generated = parseGeneratedPackage(raw);
    if (generated.final_message) {
      generated.final_message = ensureCanonicalGreeting(generated.final_message, firstName, businessContext.sample, targetLang);
    }
    lastGenerated = generated;
    text = generated.final_message;

    const issues = runQualityGate({ text, lang: targetLang, intel, template: messageTemplate, businessContext, generated, lead });
    const wrongLang = bodyLanguageConfident(text) && detectLangCode(text) !== targetLang && targetLang !== 'en';
    if (wrongLang) issues.push(`сообщение не на ${LANG_NAMES[targetLang]} языке`);

    if (!issues.length) return generated;
    lastIssues = issues;
    console.warn(`[Personalization] attempt ${attempt + 1} rejected: ${issues.join('; ')}`);
  }

  // Both attempts failed the gate. The message still went through generation,
  // so returning it beats dropping the send — but say so in the log rather than
  // pretending it passed.
  console.warn('[Personalization] quality gate not satisfied, applying deterministic fallback');
  if (businessContext.sampleMode === 'offer_template' && businessContext.sample) {
    const hook = String(lastGenerated?.personalization_hook || '').trim();
    return { ...(lastGenerated || { personalization_hook: hook, relevant_problem: '', offer_angle: '', cta: '', validJson: true }), final_message: buildStrictOfferFallback(businessContext.sample, firstName, hook), validJson: true };
  }
  return lastGenerated || { personalization_hook: '', relevant_problem: '', offer_angle: '', cta: '', final_message: text, validJson: false };
}

// ---------------------------------------------------------------------------
// Compatibility wrappers.
//
// The route layer and older stored campaigns still branch between these three
// entry points. They now share one prompt builder and one quality gate instead
// of carrying three copies of both. The three names are kept so existing calls
// keep working; new callers should use generatePersonalizedMessage directly.
// ---------------------------------------------------------------------------

export async function generateCampaignPersonalizedMessage(db, {
  messageTemplate, lead, profileData, agentContext = [], style = 'neutral', customPrompt = ''
}) {
  const result = await generatePersonalizedMessage(db, {
    messageTemplate, lead, profileData, agentContext, style, customPrompt
  });
  return result.final_message;
}

export async function generateFullPersonalizedMessage(db, {
  messageTemplate, lead, profileData, agentContext = []
}) {
  const result = await generatePersonalizedMessage(db, {
    messageTemplate, lead, profileData, agentContext, style: 'friendly'
  });
  return result.final_message;
}

export async function personalizeMessage(db, {
  messageTemplate, aiPrompt, lead, profileData, agentContext = []
}) {
  // The legacy path supplied its own instruction instead of a style. Keeping it
  // as an explicit instruction preserves old campaigns verbatim.
  const result = await generatePersonalizedMessage(db, {
    messageTemplate, lead, profileData, agentContext,
    style: 'custom', customPrompt: aiPrompt || ''
  });
  return result.final_message;
}