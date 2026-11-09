import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSummary } from '../src/services/contactEnrichService.js';
import { pickProfileFacts, buildPrompt, buildBusinessContext, buildProfileIntelligence, runQualityGate } from '../src/services/personalizationEngine.js';

const offer = buildBusinessContext({
  business_offer: 'Помогаем рекрутинговым агентствам находить компании-заказчики через Instagram и доводить заинтересованных до встречи.',
  offer_cta: 'Подскажите, вы сейчас берёте новых клиентов на подбор?',
  target_audience: 'Рекрутинговые агентства и HR-партнёры'
});

const cases = [
  ['Гаянэ', 'В профиле В профиле Гаянэ Кадашникова консультирует по найму и аудиту команд. Имеет более 15 лет практического опыта и MBA. Делится методами оценки кандидатов.', '15 лет'],
  ['Юлия', 'В профиле В профиле Юлия основала HR-компанию. Предлагает обучение HR-профессионалов. Ее агентство', 'основала HR-компанию'],
  ['Елена', 'В профиле В профиле Елена Лёвина предоставляет услуги по подбору персонала. Средний срок закрытия вакансий составляет 23 рабочих дня. Делится кейсами и отзывами.', '23 рабочих дня'],
  ['Екатерина', 'В профиле В профиле Екатерина Соболева оказывает услуги HR-консультирования. С 2017 года работает в HR, а с 2023 развивает собственную практику. Пишет о подборе персонала.', '2017'],
  ['Дарья', 'В профиле В профиле Дарья Малюк предлагает услуги по подбору персонала. Указывает на более 1000 закрытых вакансий и предлагает аудит вакансий. Подчёркивает важность понимания бизнеса.', '1000'],
  ['Анастасия', 'В профиле В профиле Анастасия Орлова подбирает руководителей и бизнес-ассистентов. С 2020 года работает с производственными и IT-компаниями. Пишет о сильных управленцах.', '2020']
];

for (const [name, summary, anchor] of cases) {
  test(`${name}: one concrete fact from the summary is highlighted next to the offer`, () => {
    const normalized = normalizeSummary(summary);
    assert.doesNotMatch(normalized, /В профиле\s+В профиле/iu);
    const facts = pickProfileFacts(normalized);
    assert.ok(facts.some(fact => fact.includes(anchor)), `${name}: ${facts.join(' | ')}`);
    const lead = { username: `case_${name}`, contact_name: name, profile_summary: summary };
    const intel = buildProfileIntelligence(null, lead);
    const { userPrompt, systemPrompt } = buildPrompt({ businessContext: offer, intel, template: '', lead, lang: 'ru', style: 'neutral' });
    assert.match(userPrompt, /КОНКРЕТНЫЕ ФАКТЫ ДЛЯ ВЫБОРА/);
    assert.ok(userPrompt.includes(anchor));
    assert.match(systemPrompt, /Единственный вопрос — CTA/iu);
    assert.match(systemPrompt, /final_message/);
  });
}

test('a grounded offer can pass without repeating a model-authored bridge verbatim', () => {
  const lead = { contact_name: 'Елена', profile_summary: cases[2][1] };
  const intel = { ...buildProfileIntelligence(null, lead), evidenceQuality: 'strong' };
  const text = 'Привет Елена. Заметил, что у вас срок закрытия вакансий 23 рабочих дня. Можем помогать с компаниями, которым нужен подбор через Instagram. Берёте сейчас новых клиентов?';
  const accepted = runQualityGate({ text, lang: 'ru', businessContext: offer, intel, lead, generated: {
    validJson: true, personalization_hook: '23 рабочих дня'
  } });
  assert.deepEqual(accepted, []);
  const missingFact = runQualityGate({ text: text.replace('23 рабочих дня', 'короткий'), lang: 'ru', businessContext: offer, intel, lead, generated: {
    validJson: true, personalization_hook: '23 рабочих дня'
  } });
  assert.ok(Array.isArray(missingFact));
});

test('generic CEO pitch from the preview is rejected for invented need and boilerplate', () => {
  const lead = { contact_name: 'Александра', profile_summary: 'Александра основала рекрутинговое агентство и работала в крупных компаниях более 12 лет.' };
  const text = 'Привет Александра, CEO и основательница рекрутингового агентства, вы ищете новые возможности для привлечения клиентов. Наша услуга может быть полезна вам, чтобы расширить клиентскую базу. Помогаем рекрутинговым агентствам находить компании-заказчики через Instagram и доводить заинтересованных до встреч. Подскажите, вы сейчас берёте новых клиентов на подбор?';
  const issues = runQualityGate({ text, lang: 'ru', businessContext: offer, intel: buildProfileIntelligence(null, lead), lead });
  assert.ok(issues.some(issue => issue.includes('неподтверждённая потребность')));
  assert.ok(issues.some(issue => issue.includes('общая рекламная связка')));
});

test('truncated tail and damaged sentences are removed without inventing missing facts', () => {
  assert.equal(normalizeSummary(cases[1][1]).endsWith('Ее агентство'), false);
  assert.equal(normalizeSummary('В профиле Дарья предлагает аудит ��акансий. У неё более 1000 закрытых вакансий.'), 'В профиле У неё более 1000 закрытых вакансий.');
});

const badExamples = [
  ['Юлия', 'Привет Юлия. Как насчет бесплатного урока по найму? Помогаем рекрутинговым агентствам находить заказчиков. Подскажите, берёте новых клиентов?'],
  ['Елена', 'Привет Елена. Какой у вас срок закрытия вакансий? Помогаем рекрутинговым агентствам находить заказчиков. Подскажите, берёте новых клиентов?'],
  ['Екатерина', 'Привет Екатерина. Какой кандидат нужен вашему бизнесу? Помогаем рекрутинговым агентствам находить заказчиков. Подскажите, берёте новых клиентов?'],
  ['Дарья', 'Привет Дарья. Какой результат должен приносить ваш сотрудник? Помогаем рекрутинговым агентствам находить заказчиков. Подскажите, берёте новых клиентов?'],
  ['Анастасия', 'Привет Анастасия, хочу обсудить, как находить сильных управленцев. Помогаем рекрутинговым агентствам находить заказчиков. Подскажите, берёте новых клиентов?']
];

for (const [name, text] of badExamples) {
  test(`${name}: observed off-topic opening is rejected before sending`, () => {
    const issues = runQualityGate({ text, lang: 'ru', businessContext: offer, intel: { hasAnyData: false }, lead: { contact_name: name } });
    assert.ok(issues.some(issue => /два вопроса|бесплатный урок|уводит в обсуждение/iu.test(issue)), issues.join('; '));
  });
}

test('bare offer without profile fact fails', () => {
  const lead = { contact_name: 'Юлия', profile_summary: cases[1][1] };
  const intel = buildProfileIntelligence(null, lead);
  const text = 'Привет Юлия, помогаем рекрутинговым агентствам находить компании-заказчики через Instagram. Берёте новых клиентов?';
  const issues = runQualityGate({ text, lang: 'ru', businessContext: offer, intel, lead, generated: { validJson: true, personalization_hook: 'основала HR-компанию' } });
  assert.ok(issues.some(issue => issue.includes('конкретный факт')));
});

test('does not invent an agency for a consultant, while a generic offer may mention agencies', () => {
  const lead = { contact_name: 'Екатерина', profile_summary: cases[3][1] };
  const intel = buildProfileIntelligence(null, lead);
  const text = 'Привет Екатерина. Вы работаете в HR с 2017 года. Помогаем вашему агентству находить компании-заказчики через Instagram. Берёте новых клиентов?';
  const issues = runQualityGate({ text, lang: 'ru', businessContext: offer, intel, lead, generated: { validJson: true, personalization_hook: 'С 2017 года работает в HR' } });
  assert.ok(issues.some(issue => issue.includes('агентством без подтверждения')));
  const neutral = text.replace('вашему агентству', 'рекрутинговым агентствам');
  const neutralIssues = runQualityGate({ text: neutral, lang: 'ru', businessContext: offer, intel, lead, generated: { validJson: true, personalization_hook: 'С 2017 года работает в HR' } });
  assert.ok(!neutralIssues.some(issue => issue.includes('агентством без подтверждения')));
});

test('personalized opener identifies an observation in the first sentence after greeting', () => {
  const lead = { contact_name: 'Елена', profile_summary: cases[2][1] };
  const intel = buildProfileIntelligence(null, lead);
  const generated = { validJson: true, personalization_hook: '23 рабочих дня' };
  const context = { lang: 'ru', businessContext: offer, intel, lead, generated };
  const base = 'Привет Елена. Вы закрываете вакансии за 23 рабочих дня. Можем помочь находить клиентов через Instagram. Актуально?';
  assert.ok(runQualityGate({ ...context, text: base }).some(x => x.includes('от первого лица')));
  for (const word of ['Увидел в профиле', 'Заметил', 'Обратил внимание']) {
    const text = base.replace('Вы закрываете', `${word}, что вы закрываете`);
    assert.ok(!runQualityGate({ ...context, text }).some(x => x.includes('от первого лица')));
  }
});
