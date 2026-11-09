// ---------------------------------------------------------------------------
// AI Agent field contract.
//
// One definition of every field the AI Agent tab owns, used by three callers
// that previously disagreed with each other:
//
//   * routes/ai-agents.js      — validates what a PUT may write, so an unknown
//                                key can never reach the table.
//   * routes/ai-agents.js GET  — hands the manifest to the UI, so the wizard
//                                renders from the same list instead of a copy
//                                that silently drifted. `voice_tone` was read by
//                                the prompt builder and had no input in the UI
//                                for months; that class of bug cannot survive a
//                                single manifest.
//   * services/personalizationEngine.js — turns stored rows into the prompt
//                                blocks, so a field that is collected is always
//                                a field that reaches the model.
//
// Stored rows stay flat ({field, value}) because the table is a key/value store.
// Everything structured (the offer, the voice, the personalization policy) is
// derived here, once, on read.
// ---------------------------------------------------------------------------

// type: 'textarea' | 'text' | 'select' | 'number'
// required: surfaced by /status so the UI can show what is still missing.
export const AGENT_SECTIONS = [
  {
    id: 'business', title: 'Бизнес и оффер',
    subtitle: 'Что вы предлагаете и кому. Эти поля объясняют модели, кому вообще подходит ваше предложение.',
    fields: [
      { key: 'company_description', label: 'Компания', type: 'textarea', maxLength: 500, placeholder: 'Кто вы, чем занимаетесь и кому помогаете.', hint: 'Коротко опишите компанию, продуктовую специализацию и кому вы помогаете.' },
      { key: 'product_name', label: 'Что вы продаёте / предлагаете', type: 'textarea', maxLength: 500, required: true, placeholder: 'Например: Контент-маркетинг для риелторов', hint: 'Короткое название продукта. То, что вы произносите вслух клиенту в первые 5 секунд.' },
      { key: 'target_audience', label: 'Кто ваша целевая аудитория', type: 'textarea', maxLength: 500, required: true, placeholder: 'Например: Риелторы и брокеры, которые хотят получать больше входящих обращений', hint: 'Модель сравнивает лида с этой группой. Если лид явно не из неё, сообщение всё равно должно звучать уместно.' },
      { key: 'problem_solved', label: 'Какую проблему вы решаете', type: 'textarea', maxLength: 500, required: true, placeholder: 'Например: Периоды без сделок и нестабильный поток обращений', hint: 'Формулируйте как боль клиента, а не как функцию продукта.' },
      { key: 'result_created', label: 'Какой результат получает клиент', type: 'textarea', maxLength: 500, placeholder: 'Например: Более стабильный поток целевых обращений из существующего контента', hint: 'Обещание, которое встраивается в сообщение.' },
      { key: 'unique_value', label: 'Уникальное преимущество', type: 'textarea', maxLength: 500, placeholder: 'Причина выбрать вас, а не похожего исполнителя.' }
    ]
  },
  {
    id: 'offer', title: 'Оффер и призыв',
    subtitle: 'Структура предложения. Эти поля модель встраивает в сообщение вместе с персонализацией, а не вместо неё.',
    fields: [
      { key: 'business_offer', label: 'Оффер одним предложением', type: 'textarea', maxLength: 500, required: true, placeholder: 'Что человек получит, если согласится.', hint: 'Пишите так, как сказали бы голосом.' },
      { key: 'offer_hook', label: 'Почему это важно сейчас', type: 'textarea', maxLength: 500, placeholder: 'Почему человеку имеет смысл ответить сейчас, а не когда-нибудь.' },
      { key: 'offer_delivery', label: 'Как отдаёте', type: 'textarea', maxLength: 500, placeholder: 'Формат, длительность, где происходит.' },
      { key: 'offer_price', label: 'Цена', type: 'text', maxLength: 200, placeholder: 'Если цена не нужна в сообщении, оставьте пустым.', hint: 'Пустое поле означает: цену не упоминать.' },
      { key: 'offer_cta', label: 'Призыв к действию', type: 'textarea', maxLength: 500, required: true, placeholder: 'Например: Open to hearing more?', hint: 'Один простой вопрос или предложение, на которое легко ответить «да».' },
      { key: 'how_it_works', label: 'Как это работает', type: 'textarea', maxLength: 1000, placeholder: 'Что делает компания, что делает клиент и как получается результат.' },
      { key: 'proof', label: 'Доказательства / Proof', type: 'textarea', maxLength: 1000, placeholder: 'Кейсы, результаты, цифры, клиенты, social proof.' },
      { key: 'guarantee', label: 'Гарантия', type: 'textarea', maxLength: 500, placeholder: 'Если гарантии нет, оставьте пустым.' },
      { key: 'message_structure', label: 'Структура сообщения', type: 'textarea', maxLength: 1000, default: '1. Personalization\n2. Relevant problem / opportunity\n3. Offer\n4. Proof\n5. CTA', placeholder: '1. Personalization\n2. Relevant problem / opportunity\n3. Offer\n4. Proof\n5. CTA', hint: 'Порядок блоков, который AI должен соблюдать.' }
    ]
  },
  {
    id: 'voice', title: 'Голос и тон',
    subtitle: 'Как именно вы пишете. Это то, что отличает сообщение от генератора.',
    fields: [
      { key: 'sender_name', label: 'Ваше имя (для подписи)', type: 'text', maxLength: 200, placeholder: 'Например: Алексей' },
      { key: 'tone', label: 'Базовый тон', type: 'select', options: [
        { value: 'friendly', label: 'Дружелюбный', desc: 'Тёплый, но без панибратства' },
        { value: 'neutral', label: 'Нейтральный', desc: 'Спокойный и универсальный' },
        { value: 'professional', label: 'Профессиональный', desc: 'Деловой, собранный' },
        { value: 'direct', label: 'Прямой', desc: 'Коротко, по делу, без подводных камней' }
      ], default: 'neutral' },
      { key: 'voice_tone', label: 'Голос своими словами', type: 'textarea', maxLength: 500, placeholder: 'Опишите свою манеру так, как объяснили бы её другу.' },
      { key: 'language', label: 'Язык сообщений', type: 'select', options: [
        { value: 'auto', label: 'Язык профиля лида (авто)' }, { value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' }, { value: 'de', label: 'Deutsch' }, { value: 'fr', label: 'Français' }, { value: 'pt', label: 'Português' }
      ], default: 'auto' },
      { key: 'sample_message_mode', label: 'Как использовать пример сообщения', type: 'select', options: [
        { value: 'style_only', label: 'Только стиль', desc: 'Сохранять манеру, но свободно менять формулировки' },
        { value: 'offer_template', label: 'Как основу оффера', desc: 'Сохранять смысл, логику и CTA; персонализировать вокруг них' }
      ], default: 'offer_template' },
      { key: 'sample_message', label: 'Пример сообщения / основа оффера', type: 'textarea', maxLength: 500, placeholder: 'Например: Yo {first_name}, are you taking on new clients now? If so, I might have something for you', hint: 'Если выбран «Как основу оффера», AI не должна заменять вашу идею другим оффером. Она только насыщает её персонализацией.' },
      { key: 'sample_message_variation', label: 'Вариативность формулировок', type: 'select', options: [
        { value: 'none', label: 'Без спинтинга', desc: 'Максимально близко к исходной формулировке' },
        { value: 'light', label: 'Лёгкая вариативность', desc: 'Можно немного менять слова и порядок, сохраняя смысл' },
        { value: 'spintax', label: 'Spintax', desc: 'Генерировать варианты в формате {вариант 1|вариант 2}' }
      ], default: 'none' }
    ]
  },
  {
    id: 'personalization', title: 'Персонализация',
    subtitle: 'Как собирается сообщение. Конспект профиля готовится здесь же, в обогащении контактов.',
    fields: [
      { key: 'personalization_opening', label: 'С чего начинать сообщение', type: 'select', options: [
        { value: 'profile_first', label: 'С детали о человеке', desc: 'Первая фраза — про него, оффер дальше' },
        { value: 'offer_first', label: 'С оффера', desc: 'Первая фраза — про вас, деталь дальше' }
      ], default: 'profile_first' },
      { key: 'summary_language', label: 'Язык конспекта', type: 'select', options: [
        { value: 'ru', label: 'Русский (внутренний)', desc: 'Конспект на русском, сообщение на языке лида' },
        { value: 'lead', label: 'Как у лида', desc: 'Конспект на языке профиля' }
      ], default: 'ru' },
      { key: 'boundaries', label: 'Запреты и ограничения', type: 'textarea', maxLength: 1000, placeholder: 'Не обещать конкретные результаты\nНе упоминать конкурентов\nНе давать скидки без согласования', hint: 'Проверяется после генерации, а не только в промпте.' },
      { key: 'link_website', label: 'Вебсайт', type: 'text', maxLength: 300, placeholder: 'https://example.com' },
      { key: 'link_instagram', label: 'Instagram', type: 'text', maxLength: 300, placeholder: 'https://instagram.com/yourpage' },
      { key: 'link_telegram', label: 'Telegram', type: 'text', maxLength: 300, placeholder: 'https://t.me/yourchannel' },
      { key: 'link_other', label: 'Другие ссылки', type: 'textarea', maxLength: 1000, placeholder: 'По одной на строку' }
    ]
  }
];
export const AGENT_FIELDS = AGENT_SECTIONS.flatMap(s => s.fields);
export const AGENT_FIELD_KEYS = AGENT_FIELDS.map(f => f.key);

const FIELD_BY_KEY = new Map(AGENT_FIELDS.map(f => [f.key, f]));

// Fields that predate the manifest. They are still written on a round trip so a
// GET → PUT from an older open tab cannot wipe data this version does not render.
export const LEGACY_AGENT_FIELDS = [
  'conversation_goal', 'qualification', 'questions_pricing', 'followups', 'links'
];

export const WRITABLE_AGENT_FIELDS = new Set([...AGENT_FIELD_KEYS, ...LEGACY_AGENT_FIELDS]);

export const REQUIRED_AGENT_FIELDS = AGENT_FIELDS.filter(f => f.required).map(f => f.key);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clampInt(value, field) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return field.default ?? null;
  return Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
}

// Coerces one incoming value to what its field can actually hold. Returns
// undefined for "do not write this key" so a partial PUT stays partial.
export function sanitizeAgentValue(key, rawValue) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) {
    // Legacy free-text field: keep whatever the caller sent, bounded.
    return String(rawValue ?? '').slice(0, 2000);
  }

  if (rawValue === null || rawValue === undefined) return field.type === 'number' ? String(field.default ?? '') : '';

  if (field.type === 'number') {
    return String(clampInt(rawValue, field));
  }

  if (field.type === 'select') {
    const value = String(rawValue).trim();
    const allowed = field.options.map(o => o.value);
    // A previously saved value must survive a rule change, so unknown options
    // are stored as-is; only obviously wrong types fall back to the default.
    return allowed.includes(value) ? value : (field.options[0]?.value ?? '');
  }

  const text = String(rawValue).replace(/\r\n/g, '\n');
  return field.maxLength ? text.slice(0, field.maxLength) : text;
}

// ---------------------------------------------------------------------------
// Read + normalize
// ---------------------------------------------------------------------------

export function readAgentContextMap(db) {
  const rows = db.prepare('SELECT field, value FROM ai_business_context').all();
  const map = {};
  for (const row of rows) map[row.field] = String(row.value ?? '');
  return map;
}

const TONE_NAMES = {
  friendly: 'дружелюбный, тёплый, без панибратства',
  neutral: 'нейтральный, спокойный, универсальный',
  professional: 'профессиональный, деловой, собранный',
  direct: 'прямой, короткий, без заусложнений'
};

function line(label, value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const body = max ? clip(text, max) : text;
  return `${label}: ${body}`;
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// agentContext arrives either as {field, value} rows (route layer) or as an
// already-flattened object (tests, callers that already hold the map).
export function toContextMap(agentContext) {
  if (!agentContext) return {};
  if (Array.isArray(agentContext)) {
    const map = {};
    for (const row of agentContext) {
      const value = String(row?.value ?? '').trim();
      if (value) map[row.field] = value;
    }
    return map;
  }
  const map = {};
  for (const [key, value] of Object.entries(agentContext)) {
    const text = String(value ?? '').trim();
    if (text) map[key] = text;
  }
  return map;
}

// Required-but-empty fields. Shared by the status endpoint and the send path so
// "the agent is configured" means one thing everywhere.
export function missingRequiredFields(agentContext) {
  const map = toContextMap(agentContext);
  return REQUIRED_AGENT_FIELDS.filter(key => !String(map[key] || '').trim());
}

// The single normalization used by every AI call that needs the agent. Returns
// pre-rendered prompt blocks plus the parsed policy values, so a caller never
// re-implements "what does opening=profile_first mean".
export function normalizeAgentContext(agentContext) {
  const map = toContextMap(agentContext);

  const opening = map.personalization_opening === 'offer_first' ? 'offer_first' : 'profile_first';
  const greeting = 'name';
  const summaryMaxWords = 120;
  const summaryLanguage = map.summary_language === 'lead' ? 'lead' : 'ru';
  const messageStructure = String(map.message_structure || '1. Personalization\n2. Relevant problem / opportunity\n3. Offer\n4. Proof\n5. CTA').trim();
  const language = map.language || 'auto';
  const tone = TONE_NAMES[map.tone] ? map.tone : 'neutral';

  const offer = [
    line('КОМПАНИЯ', map.company_description, 300),
    line('ПРОДУКТ', map.product_name, 300),
    line('СУТЬ ОФФЕРА (что человек получит, если согласится)', map.business_offer || map.product_name, 400),
    line('ПОЧЕМУ АКТУАЛЬНО СЕЙЧАС', map.offer_hook, 300),
    line('ФОРМАТ И СПОСОБ', map.offer_delivery, 250),
    line('ЦЕНА', map.offer_price, 120),
    line('ЦЕЛЕВАЯ АУДИТОРИЯ', map.target_audience, 250),
    line('БОЛЬ КЛИЕНТА', map.problem_solved, 300),
    line('РЕЗУЛЬТАТ', map.result_created, 200),
    line('ЧЕМ ОТЛИЧАЕСЬ', map.unique_value, 250),
    line('КАК ЭТО РАБОТАЕТ', map.how_it_works, 500),
    line('ДОКАЗАТЕЛЬСТВА', map.proof, 500),
    line('ГАРАНТИЯ', map.guarantee, 300),
    line('СТРУКТУРА СООБЩЕНИЯ', messageStructure, 700),
    line('ЧТО ПРОСИМ В ОТВЕТ (должен прозвучать в каждом сообщении)', map.offer_cta, 250)
  ].filter(Boolean).join('\n');

  const style = [
    line('ТОН', [TONE_NAMES[tone], map.voice_tone].filter(Boolean).join('. '), 300),
    line('ИМЯ ОТПРАВИТЕЛЯ', map.sender_name, 100),
    (map.sample_message && map.sample_message_mode === 'style_only')
      ? `ПРИМЕР СООБЩЕНИЯ (только образец стиля):\n${clip(map.sample_message, 500)}`
      : ''
  ].filter(Boolean).join('\n');

  const guardrails = [map.boundaries, map.qualification ? `Квалификация: ${map.qualification}` : '']
    .filter(Boolean).join('\n');

  const links = [
    map.link_website, map.link_instagram, map.link_telegram, map.link_other
  ].map(v => String(v || '').trim()).filter(Boolean);

  return {
    map,
    offer,
    offerText: offer,
    style,
    guardrails,
    links,
    sample: map.sample_message || '',
    sampleMode: map.sample_message_mode === 'style_only' ? 'style_only' : 'offer_template',
    sampleVariation: ['light', 'spintax'].includes(map.sample_message_variation) ? map.sample_message_variation : 'none',
    boundaries: map.boundaries || '',
    // Parsed policy — the prompt builder and the quality gate both read these
    // instead of re-deriving intent from strings.
    policy: {
      opening,
      greeting,
      summaryMaxWords,
      summaryLanguage,
      language,
      tone,
      hasOffer: Boolean((map.business_offer || map.product_name || '').trim()),
      hasStyle: Boolean((map.voice_tone || map.sample_message || '').trim()),
      strictOfferTemplate: map.sample_message_mode !== 'style_only' && Boolean(String(map.sample_message || '').trim())
    }
  };
}

// Rendered instruction lines for the personalization policy. Kept next to the
// values that produce them so a new policy option cannot be added without
// stating what it means to the model.
export function policyInstructions(policy) {
  const parts = [];

  if (policy.strictOfferTemplate) {
    parts.push('НЕ ИЗМЕНЯЙ ПОРЯДОК КАНОНИЧЕСКОГО ОФФЕРА. Добавь персонализацию внутрь него или сразу после приветствия, не создавай отдельный вступительный абзац.');
  } else if (policy.opening === 'offer_first') {
    parts.push('НАЧНИ С ОФФЕРА: первая фраза — про предложение. Деталь из профиля встрой во вторую-третью.');
  } else {
    parts.push('НАЧНИ С ЧЕЛОВЕКА: первая фраза — про него, про то, что видно в его профиле. Оффер встрой следом, без «кстати, у нас есть…».');
  }

  parts.push('ОБРАЩАЙСЯ ПО ИМЕНИ ВСЕГДА: используй только имя из Contacts. Начинай с приветствия + имени. Username, bio и Instagram display name не являются источником имени.');
  return parts;
}
