import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeCanonicalGreeting, runQualityGate } from '../src/services/personalizationEngine.js';

test('removes duplicate greeting and repeated name from generated Russian DM', () => {
  const input = 'Привет Александра, Заметила ваши советы по карьерному росту, Александра., Привет Александра, Подскажите, вы сейчас берёте новых клиентов на подбор?';
  assert.equal(
    dedupeCanonicalGreeting(input, 'Александра', 'ru'),
    'Привет Александра, Заметила ваши советы по карьерному росту. Подскажите, вы сейчас берёте новых клиентов на подбор?'
  );
});

test('keeps a single canonical greeting when model repeats it without a name before it', () => {
  const input = 'Привет Александра, Ваш профиль интересен. Привет Александра, подскажите, вы берёте клиентов?';
  assert.equal(
    dedupeCanonicalGreeting(input, 'Александра', 'ru'),
    'Привет Александра, Ваш профиль интересен. подскажите, вы берёте клиентов?'
  );
});

test('adds a target-language greeting when model omitted it', () => {
  assert.equal(
    dedupeCanonicalGreeting('Заметил ваш пост о найме. Подскажите, актуально?', 'Александра', 'ru'),
    'Привет Александра, Заметил ваш пост о найме. Подскажите, актуально?'
  );
});


test('quality gate accepts a correctly greeted Russian message', () => {
  const issues = runQualityGate({
    text: 'Привет Гаяна, заметил, что вы делитесь методами оценки управленческих навыков. Помогаем рекрутинговым агентствам находить компании-заказчики. Подскажите, актуально?',
    lang: 'ru', lead: { contact_name: 'Гаяна Кадашникова' },
    intel: { hasAnyData: false }, businessContext: { policy: { greeting: 'name' } }
  });
  assert.equal(issues.some(x => x.includes('должно начинаться с одного приветствия')), false, issues.join('; '));
});

test('quality gate flags a repeated recipient name', () => {
  const issues = runQualityGate({
    text: 'Привет Гаяна, заметил ваш профиль, Гаяна. Подскажите, актуально?',
    lang: 'ru', lead: { contact_name: 'Гаяна Кадашникова' },
    intel: { hasAnyData: false }, businessContext: { policy: { greeting: 'name' } }
  });
  assert.equal(issues.some(x => x.includes('имя Гаяна повторяется')), true, issues.join('; '));
});


test('removes duplicate greeting when the model uses a comma after greeting', () => {
  const input = 'Привет Гаяна, Привет, Гаяна! Учитывая ваш опыт в аудите команд и подборе ключевых сотрудников, подскажите, вы сейчас берёте новых клиентов на подбор?';
  assert.equal(
    dedupeCanonicalGreeting(input, 'Гаяна', 'ru'),
    'Привет Гаяна, Учитывая ваш опыт в аудите команд и подборе ключевых сотрудников, подскажите, вы сейчас берёте новых клиентов на подбор?'
  );
});

test('removes repeated name even when it is not attached to a second greeting', () => {
  const input = 'Привет Гаяна, учитывая ваш опыт, Гаяна, помогаем агентствам находить клиентов. Подскажите, актуально?';
  assert.equal(
    dedupeCanonicalGreeting(input, 'Гаяна', 'ru'),
    'Привет Гаяна, учитывая ваш опыт, помогаем агентствам находить клиентов. Подскажите, актуально?'
  );
});


test('quality gate rejects Unicode replacement characters and mojibake', () => {
  const common = {
    lang: 'ru', lead: { contact_name: 'Инесса Тихонова' },
    intel: { hasAnyData: false }, businessContext: { policy: { greeting: 'name' } }
  };
  const replacement = runQualityGate({ ...common, text: 'Привет Инесса, помогаем компаниям-зака��чики найти сотрудников. Актуально?' });
  assert.equal(replacement.some(x => x.includes('повреждённые/неправильно декодированные символы')), true, replacement.join('; '));
  const mojibake = runQualityGate({ ...common, text: 'Привет Инесса, Ã©то повреждённая фраза. Актуально?' });
  assert.equal(mojibake.some(x => x.includes('повреждённые/неправильно декодированные символы')), true, mojibake.join('; '));
});

import { parseGeneratedPackage, buildPrompt, buildBusinessContext } from '../src/services/personalizationEngine.js';

test('malformed JSON response never leaks its envelope into the DM', () => {
  const parsed = parseGeneratedPackage('{"personalization_hook":"", привет! Вы, наверное, знаете как важно...');
  assert.equal(parsed.validJson, false);
  assert.equal(parsed.final_message, '');
  assert.equal(parsed.final_message.includes('personalization_hook'), false);
});

test('valid structured output extracts only final_message', () => {
  const parsed = parseGeneratedPackage(JSON.stringify({
    personalization_hook: '15 лет в подборе', relevant_problem: '', offer_angle: 'поиск клиентов', cta: 'актуально?',
    final_message: 'Привет, Анна! Увидел ваш опыт в подборе. Актуально?'
  }));
  assert.equal(parsed.validJson, true);
  assert.equal(parsed.final_message, 'Привет, Анна! Увидел ваш опыт в подборе. Актуально?');
});

test('generator instructions consistently require JSON rather than conflicting plain text', () => {
  const { systemPrompt } = buildPrompt({
    businessContext: { policy: { language: 'ru', greeting: 'name' }, sampleMode: 'offer_template', sample: 'Помогаем компаниям находить клиентов. Актуально?' },
    intel: { text: 'Конспект: 15 лет в подборе персонала', hooks: '15 лет в подборе персонала', hasAnyData: true },
    template: '', lead: { contact_name: 'Анна Иванова' }, lang: 'ru', style: 'neutral', customPrompt: ''
  });
  assert.match(systemPrompt, /только валидный JSON/i);
  assert.doesNotMatch(systemPrompt, /Верни только готовый текст сообщения:/i);
});

test('structured offer and CTA reach the writer when the optional sample is empty', () => {
  const businessContext = buildBusinessContext({
    business_offer: 'Сценарии Reels для фитнес-тренеров',
    offer_cta: 'Хотите увидеть пример?',
    target_audience: 'Фитнес-тренеры'
  });
  const { userPrompt } = buildPrompt({ businessContext, intel: { text: 'Тренер готовит бегунов к марафону', hooks: '' }, template: '', lead: { contact_name: 'Анна' }, lang: 'ru', style: 'neutral' });
  assert.match(userPrompt, /ОБЯЗАТЕЛЬНЫЙ ОФФЕР: Сценарии Reels для фитнес-тренеров/);
  assert.match(userPrompt, /ОБЯЗАТЕЛЬНЫЙ CTA: Хотите увидеть пример\?/);
  assert.match(userPrompt, /Тренер готовит бегунов к марафону/);
});

test('fluent offer paraphrase is not rejected by token overlap', () => {
  const businessContext = buildBusinessContext({
    business_offer: 'Сценарии Reels для фитнес-тренеров',
    offer_cta: 'Хотите увидеть пример?',
    sample_message: 'Я создаю сценарии коротких видео, которые приводят фитнес-тренерам заявки. Хотите увидеть пример?',
    sample_message_mode: 'offer_template'
  });
  const issues = runQualityGate({
    text: 'Привет Анна, для вашей работы с марафонцами могу предложить идеи роликов, которые помогут получать обращения. Хотите увидеть пример?',
    lang: 'ru', lead: { contact_name: 'Анна' }, intel: { hasAnyData: false }, businessContext
  });
  assert.equal(issues.some(issue => issue.includes('канонического оффера')), false, issues.join('; '));
});

test('personalized greeting ends with a period and the next sentence starts with a capital', async () => {
  const { formatGreetingSentence } = await import('../src/services/personalizationEngine.js');
  for (const source of ['Привет Елена, у вас 23 рабочих дня.', 'Привет, Елена. у вас 23 рабочих дня.', 'Привет Елена! У вас 23 рабочих дня.']) {
    assert.equal(formatGreetingSentence(source, 'Елена', 'ru'), 'Привет Елена. У вас 23 рабочих дня.');
  }
});

test('a long dash alone does not reject the preview', () => {
  const issues = runQualityGate({ text: 'Привет Елена. У вас подбор — за 23 дня. Актуально?', lang: 'ru', lead: { contact_name: 'Елена' }, intel: { hasAnyData: false }, businessContext: { policy: { greeting: 'name' } } });
  assert.ok(!issues.some(issue => issue.includes('длинное тире')));
});
