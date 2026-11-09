import db from '../db/schema.js';

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function generateMessage({ provider, prompt, lead, template }) {
  const settings = getSettings();

  const systemPrompt = `Ты эксперт по холодным продажам в Инстаграме.
Пиши короткие, персонализированные и живые сообщения на русском языке.
Сообщение должно быть не более 300 символов, без хештегов, звучать по-человечески.
Используй информацию о лиде для персонализации.`;

  const userPrompt = prompt ||
    `Напиши холодное сообщение для аккаунта @${lead.username}${lead.full_name ? ` (${lead.full_name})` : ''}${lead.niche ? ` из ниши "${lead.niche}"` : ''}.
Шаблон оффера: ${template}
Персонализируй под этого конкретного человека.`;

  const chosenProvider = provider || settings.default_ai_provider || 'claude';

  if (chosenProvider === 'claude') {
    if (!settings.anthropic_api_key) throw new Error('Anthropic API ключ не настроен');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: settings.anthropic_api_key });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    return response.content[0].text.trim();
  }

  if (chosenProvider === 'openai') {
    if (!settings.openai_api_key) throw new Error('OpenAI API ключ не настроен');
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: settings.openai_api_key });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 400
    });
    return response.choices[0].message.content.trim();
  }

  throw new Error('Неизвестный AI провайдер');
}
