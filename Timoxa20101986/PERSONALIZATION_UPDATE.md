# Personalization update

Изменения в текущем проекте:

- Lead Intelligence поднят до `ENRICH_VERSION = 6`.
- Введён более строгий контракт summary/facts/hooks.
- Summary и hooks проверяются на связь с реальным scraped profile.
- Hooks теперь действительно сохраняются в `profile_summary_meta` и доступны второму AI.
- Убран follower-count из AI personalization context.
- Убран конфликт JSON vs «только текст» в prompt второго AI.
- Второй AI обязан вернуть структурированный JSON: hook/problem/offer_angle/cta/final_message.
- Quality Gate проверяет JSON, персональный повод, grounding, CTA, язык, длину, клише и копирование reference/template.
- Retry теперь просит вернуть полный JSON-пакет, а не только исправленный текст.
- При двух неудачных попытках сохраняется последний структурированный результат для истории/диагностики.
- Улучшено автоопределение FR/PT/IT и исправлено «портагальском» → «португальском».
- Старый DM больше не переиспользуется только потому, что `message_sent` заполнен.
- Добавлен `personalization_summary_hash`; DM переиспользуется только при совпадении AI Agent version + summary version + content hash.
- При stale DM старый `message_sent` очищается перед новой генерацией.
- Обновлена `SMART_PERSONALIZATION_GUIDE.md` под фактическую архитектуру.

## Проверка

Все backend JS-файлы проходят `node --check`.

Полный `npm test` в исходной среде не удалось выполнить из-за повреждённой/неполной установки `backend/node_modules` после timeout `npm ci`; существующие тесты `offerContext` выполняются, кроме одного baseline-ожидания, которое было 90 при фактическом default `summaryMaxWords = 120` и синхронизировано до 120.

## Contact name source of truth

The contact's saved `full_name` from the Contacts table is the authoritative greeting name for AI personalization. The generator must never infer a greeting name from the Instagram username or replace the saved contact name with a scraped Instagram display name. If the contact has no saved name, do not invent one and do not use the username as a greeting.

## v9 offer-first correction
The AI Agent now treats the configured example message as the canonical offer in `offer_template` mode. Message-length and summary-length controls were removed from the user-facing Agent settings. Contact name is always taken from Contacts, and every generated DM is required to start with a greeting + that saved name. Strict mode has a quality gate for canonical-offer overlap and a deterministic fallback when the model drifts away from the offer.
