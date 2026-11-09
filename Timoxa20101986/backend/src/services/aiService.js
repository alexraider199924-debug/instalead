import https from 'https';

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getApiKey(db) {
  const settings = getSettings(db);
  const apiKey = settings.openrouter_api_key;
  if (!apiKey) throw new Error('OpenRouter API ключ не настроен. Добавьте его в Интеграциях.');
  return apiKey;
}

// GPT-4o mini is broadly available through OpenRouter and is the safe default.
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

// OpenRouter model ids are `vendor/model`, with hyphens/underscores/dots in
// both halves. Kept permissive on purpose so any model published on OpenRouter
// (not just the ones this app ships a shortcut for) can be used.
const MODEL_ID_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

export function isValidModelId(value) {
  return MODEL_ID_PATTERN.test(String(value ?? '').trim());
}

function getModel(db, requestedModel) {
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_model'").get()?.value;
  const candidate = requestedModel || String(saved || '').trim();
  return isValidModelId(candidate) ? candidate : DEFAULT_MODEL;
}

// Retry wrapper with exponential backoff
async function callWithRetry(fn, maxRetries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      // Authentication and policy denials are deterministic; retrying cannot fix them.
      if (e.message.includes('Invalid OpenRouter API key') || e.message.includes('401') || e.message.includes('403')) {
        throw e;
      }

      // Don't retry if it's the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 1s, 2s
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[OpenRouter] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Detect language from text: 'en', 'ru', 'es', 'de', 'fr', 'it', 'pt'
function detectLanguage(text) {
  if (!text) return 'en';
  const lowerText = text.toLowerCase();

  // Russian: ё, й, ц, ч, ш, щ, ъ, ы, э, ю, я + Cyrillic
  if (/[ёйцчшщъыэюя]/i.test(text) || /[а-яА-ЯЁ]/.test(text)) return 'ru';

  // English: common words
  if (/\b(the|a|and|to|of|in|for|is|be|have|with|this|that)\b/i.test(lowerText)) return 'en';

  // Spanish: common words
  if (/\b(el|la|de|que|y|a|en|un|una|los|las)\b/i.test(lowerText)) return 'es';

  // German: common words
  if (/\b(der|die|das|und|in|den|von|zu|ein|eine)\b/i.test(lowerText)) return 'de';

  // French: common words
  if (/\b(le|la|de|et|un|une|les|à|en|pour)\b/i.test(lowerText)) return 'fr';

  return 'en';
}

// Validate message language matches expected
function isValidLanguage(message, expectedLang) {
  if (!expectedLang || expectedLang === 'auto') return true;
  const detectedLang = detectLanguage(message);
  return detectedLang === expectedLang;
}

// Exported so other AI features (lead search planning and scoring) reuse one
// place for key lookup, headers and error shape instead of each growing its
// own fetch wrapper that drifts out of sync.
export async function callOpenRouter(db, systemPrompt, userPrompt, maxTokens = 500, options = {}) {
  // options.apiKey lets the settings screen verify a key the user just typed
  // before it is saved; every other caller keeps the stored key.
  const apiKey = options.apiKey ? String(options.apiKey).trim() : getApiKey(db);
  if (!apiKey) throw new Error('OpenRouter API ключ не настроен. Добавьте его в Интеграциях.');

  const model = getModel(db, options.model);
  console.log(`[OpenRouter] Calling model: ${model}`);

  // Reasoning models (e.g. stealth/space-bunny-alpha) emit an internal
  // `reasoning` field first and can spend the entire token budget on it,
  // returning content: null. Retry once with a bigger budget instead of
  // failing with "Empty response" — the caller asked for a message, not for a
  // model's chain of thought.
  let budget = maxTokens;
  let requestOptions = { ...options };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await requestCompletion(apiKey, model, systemPrompt, userPrompt, budget, requestOptions);

    if (result.ok) return result.text;

    // Some OpenRouter provider routes can advertise the model while not
    // accepting every optional parameter. Structured output is valuable, but
    // it must never make enrichment completely unusable. Fall back once to the
    // the same configured model without response_format, then let the parser validate it.
    if (result.parameterError && requestOptions.responseFormat) {
      const { responseFormat: _ignored, ...withoutFormat } = requestOptions;
      requestOptions = withoutFormat;
      console.warn(`[OpenRouter] ${model} rejected response_format; retrying without structured-output transport`);
      continue;
    }

    if (!result.reasoningOnly || attempt === 2) throw new Error(result.error);

    budget = Math.min(Math.max(budget * 2, 4000), 12000);
    console.warn(`[OpenRouter] ${model} spent its budget on reasoning, retrying with max_tokens=${budget}`);
  }
}

function requestCompletion(apiKey, model, systemPrompt, userPrompt, maxTokens, options = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens
  };

  // The configured model supports controllable adaptive reasoning and structured JSON.
  // Keep these opt-in so legacy callers keep their old wire format.
  if (options.reasoning) body.reasoning = options.reasoning;
  if (options.responseFormat) body.response_format = options.responseFormat;
  if (options.provider) body.provider = options.provider;

  const payload = JSON.stringify(body);

  const payloadBuffer = Buffer.from(payload, 'utf-8');

  return new Promise((resolve, reject) => {
    let resolved = false;

    const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.length,
        // A stale localhost referer may conflict with a key's OpenRouter referrer
        // restrictions. Send it only when explicitly configured for the domain.
        ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'Instalead'
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      let chunks = [];

      res.on('data', chunk => {
        chunks.push(chunk);
        data += chunk;
      });

      res.on('end', () => {
        if (resolved) return;
        resolved = true;

        if (res.statusCode !== 200) {
          // Preserve the raw provider body in backend logs for diagnosis.
          console.error(`[OpenRouter] HTTP ${res.statusCode} response: ${data}`);
        }

        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(data);
            const message = parsed.choices?.[0]?.message || {};
            if (typeof message.content === 'string' && message.content.trim()) {
              resolve({ ok: true, text: message.content.trim() });
              return;
            }
            // content is empty but reasoning is present: the model burned the
            // whole budget thinking. Let the caller retry with more tokens.
            resolve({
              ok: false,
              reasoningOnly: Boolean(String(message.reasoning || '').trim()),
              error: `OpenRouter вернул пустой ответ от модели ${model}`
            });
            return;
          } else if (res.statusCode === 429) {
            throw new Error('Rate limited by OpenRouter');
          } else if (res.statusCode === 401) {
            throw new Error('Invalid OpenRouter API key');
          } else if (res.statusCode >= 500) {
            throw new Error(`OpenRouter server error: ${res.statusCode}`);
          } else {
            // Keep the complete, structured provider response in the error. In
            // particular, OpenRouter's 403 body explains whether this is a key,
            // model/provider, or account security-policy restriction. The error
            // field is an object on some endpoints and a plain string on the
            // edge/WAF layer, so both shapes are unwrapped here.
            let detail = data;
            try {
              const parsed = JSON.parse(data);
              const raw = parsed.error;
              detail = raw?.message
                || raw?.metadata?.message
                || (typeof raw === 'string' ? raw : '')
                || parsed.message
                || data;
            } catch {}
            const error = new Error(`OpenRouter error: ${res.statusCode} ${String(detail).slice(0, 1000)}`);
            error.parameterError = (res.statusCode === 400 || res.statusCode === 422) && Boolean(options.responseFormat);
            throw error;
          }
        } catch (e) {
          reject(e);
        }
      });

      res.on('error', (e) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Response error from OpenRouter: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        console.error('[OpenRouter] Request error:', e.message, e.code);
        reject(new Error(`Ошибка подключения к OpenRouter: ${e.message}`));
      }
    });

    req.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        reject(new Error('Ошибка подключения к OpenRouter: timeout (>60 сек)'));
      }
    });

    req.on('close', () => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Соединение закрыто неожиданно'));
      }
    });

    try {
      req.write(payloadBuffer);
      req.end();
    } catch (e) {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Ошибка при отправке запроса: ${e.message}`));
      }
    }
  });
}

// Models wrap JSON in prose or a ``` fence often enough that asking nicely in
// the prompt is not sufficient on its own. Pull out the outermost brace-
// delimited object rather than trusting the whole reply to parse.
export function parseJsonReply(text) {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {}
  }
  throw new Error('AI вернул не-JSON ответ: ' + cleaned.slice(0, 200));
}

export async function generateMessage(db, { prompt, lead, template }) {
  // Detect target language from template
  const templateLang = detectLanguage(template);
  const langMap = {
    ru: 'русском',
    en: 'английском',
    es: 'испанском',
    de: 'немецком',
    fr: 'французском',
    it: 'итальянском',
    pt: 'португальском'
  };
  const langName = langMap[templateLang] || 'русском';

  const systemPrompt = `Ты эксперт по холодным продажам в Инстаграме.
🔴 КРИТИЧНО: Пиши сообщения СТРОГО на ${langName} языке. Никогда не меняй язык.
Сообщение должно быть не более 300 символов, без хештегов, звучать по-человечески.
Используй информацию о лиде для персонализации.
Если в шаблоне есть {first_name} — замени на имя лида.`;

  const userPrompt = prompt ||
    `Напиши холодное сообщение для аккаунта @${lead.username}${lead.full_name ? ` (${lead.full_name})` : ''}${lead.niche ? ` из ниши "${lead.niche}"` : ''}.
Язык: ${langName}
Шаблон оффера: ${template}
Персонализируй под этого конкретного человека на ${langName} языке.`;

  let result = await callWithRetry(() => callOpenRouter(db, systemPrompt, userPrompt, 400));

  // Validate language and retry if wrong
  if (!isValidLanguage(result, templateLang)) {
    console.warn(`[AI] Wrong language detected (expected ${templateLang}), retrying...`);
    const retryPrompt = `ВНИМАНИЕ: Предыдущее сообщение было на неправильном языке.
ОБЯЗАТЕЛЬНО верни сообщение СТРОГО на ${langName} языке, без переводов и смешиваний.

${userPrompt}`;
    result = await callWithRetry(() => callOpenRouter(db, systemPrompt, retryPrompt, 400));
  }

  return result;
}

