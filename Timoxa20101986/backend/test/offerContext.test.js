import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SECTIONS,
  REQUIRED_AGENT_FIELDS,
  WRITABLE_AGENT_FIELDS,
  missingRequiredFields,
  normalizeAgentContext,
  policyInstructions,
  sanitizeAgentValue
} from '../src/services/offerContext.js';

test('every field is declared exactly once and has a type the wizard can render', () => {
  const keys = AGENT_SECTIONS.flatMap(s => s.fields.map(f => f.key));
  assert.equal(new Set(keys).size, keys.length, 'duplicate field key in the manifest');
  for (const section of AGENT_SECTIONS) {
    assert.ok(section.id && section.title && section.subtitle, `section ${section.id} is missing copy`);
    for (const field of section.fields) {
      assert.ok(field.label, `${field.key} has no label`);
      assert.ok(['textarea', 'text', 'select', 'number'].includes(field.type), `${field.key} has an unknown type`);
      if (field.type === 'select') {
        assert.ok(field.options?.length, `${field.key} is a select with no options`);
        assert.ok(field.options.some(o => o.value === o.value?.trim()), `${field.key} has an empty option value`);
      }
    }
  }
});

test('required fields are spread across the sections a first-time user must open', () => {
  // A required field the UI never shows would leave "configured" permanently
  // false with no way to fix it, so this is a contract, not a style choice.
  for (const key of REQUIRED_AGENT_FIELDS) {
    assert.ok(WRITABLE_AGENT_FIELDS.has(key), `${key} is required but not writable`);
    assert.ok(
      AGENT_SECTIONS.some(s => s.fields.some(f => f.key === key)),
      `${key} is required but not rendered anywhere`
    );
  }
});

test('sanitizeAgentValue coerces each field to what it can hold', () => {
  assert.equal(sanitizeAgentValue('personalization_opening', 'hacked'), 'profile_first', 'unknown option rejected');
  assert.equal(sanitizeAgentValue('personalization_opening', 'offer_first'), 'offer_first');

  assert.equal(sanitizeAgentValue('product_name', 'x'.repeat(900)).length, 500, 'textarea is length-capped');
  assert.equal(sanitizeAgentValue('conversation_goal', 'y'.repeat(5000)).length, 2000, 'legacy field is bounded');
  assert.equal(sanitizeAgentValue('product_name', null), '');
});

test('a single missing required field keeps the agent unconfigured', () => {
  const complete = {
    product_name: 'Разбор профиля',
    target_audience: 'Эксперты',
    problem_solved: 'Нет заявок',
    business_offer: 'Аудит за 40 минут',
    offer_cta: 'Скиньте профиль'
  };
  assert.deepEqual(missingRequiredFields(complete), []);
  for (const key of REQUIRED_AGENT_FIELDS) {
    const partial = { ...complete, [key]: '' };
    assert.deepEqual(missingRequiredFields(partial), [key], `${key} empty should be reported`);
  }
});

test('a product name alone is not an offer', () => {
  // This is the regression the old check allowed: "configured" used to pass on
  // any one of four fields, so an empty offer still produced personalized DMs.
  assert.deepEqual(
    missingRequiredFields({ product_name: 'Курс по таргету', target_audience: 'Блогеры' }),
    ['problem_solved', 'business_offer', 'offer_cta']
  );
});

test('normalizeAgentContext renders the offer parts separately', () => {
  const ctx = normalizeAgentContext([
    { field: 'product_name', value: 'Аудит профиля' },
    { field: 'business_offer', value: 'Разбираю профиль за 40 минут' },
    { field: 'offer_cta', value: 'Скиньте профиль в директ' },
    { field: 'offer_price', value: 'Бесплатно' },
    { field: 'voice_tone', value: 'Без понтов, коротко' },
    { field: 'tone', value: 'friendly' }
  ]);

  assert.match(ctx.offer, /СУТЬ ОФФЕРА.*Разбираю профиль за 40 минут/);
  assert.match(ctx.offer, /ЧТО ПРОСИМ В ОТВЕТ.*Скиньте профиль в директ/);
  assert.match(ctx.offer, /ЦЕНА: Бесплатно/);
  assert.match(ctx.style, /дружелюбный/);
  assert.match(ctx.style, /Без понтов, коротко/);
  assert.equal(ctx.policy.hasOffer, true);
  assert.equal(ctx.policy.hasStyle, true);
  assert.equal(ctx.policy.tone, 'friendly');
});

test('policy defaults are safe when nothing is configured', () => {
  const ctx = normalizeAgentContext([]);
  assert.equal(ctx.policy.opening, 'profile_first');
  assert.equal(ctx.policy.greeting, 'name');
  assert.equal('length' in ctx.policy, false);
  assert.equal(ctx.policy.summaryMaxWords, 120);
  assert.equal(ctx.policy.summaryLanguage, 'ru');
  assert.equal(ctx.policy.hasOffer, false);
});

test('policyInstructions states every policy the prompt depends on', () => {
  const text = policyInstructions(normalizeAgentContext([]).policy).join('\n');
  assert.match(text, /НАЧНИ С ЧЕЛОВЕКА/);
  assert.match(text, /ОБРАЩАЙСЯ ПО ИМЕНИ ВСЕГДА/);
  assert.doesNotMatch(text, /420/);
});

test('name is always required and cannot be disabled from the agent settings', () => {
  const ctx = normalizeAgentContext({ personalization_opening: 'offer_first', personalization_greeting: 'no_greeting' });
  const text = policyInstructions(ctx.policy).join('\n');
  assert.match(text, /НАЧНИ С ОФФЕРА/);
  assert.match(text, /ОБРАЩАЙСЯ ПО ИМЕНИ ВСЕГДА/);
  assert.equal(ctx.policy.greeting, 'name');
});

test('strict offer template is a first-class policy', () => {
  const ctx = normalizeAgentContext({ sample_message_mode: 'offer_template', sample_message: 'Yo {first_name}, are you taking on new clients now?' });
  assert.equal(ctx.sampleMode, 'offer_template');
  assert.equal(ctx.policy.strictOfferTemplate, true);
  const text = policyInstructions(ctx.policy).join('\n');
  assert.match(text, /НЕ ИЗМЕНЯЙ ПОРЯДОК КАНОНИЧЕСКОГО ОФФЕРА/);
});

test('accepts both row arrays and a flattened map', () => {
  const rows = [{ field: 'product_name', value: 'Аудит' }];
  assert.equal(normalizeAgentContext(rows).policy.hasOffer, true);
  assert.equal(normalizeAgentContext({ product_name: 'Аудит' }).policy.hasOffer, true);
  assert.equal(normalizeAgentContext([{ field: 'product_name', value: '  ' }]).policy.hasOffer, false);
});