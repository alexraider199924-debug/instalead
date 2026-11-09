# Enrichment stability fix — v8

## What changed

The enrichment pipeline no longer treats a model-format mismatch as a fatal job error.

Flow:

1. Instagram profile is scraped and stored.
2. Batch Lead Intelligence request is sent to the configured OpenRouter model.
3. If the batch response is incomplete or semantically weak, each missing profile gets a single-profile retry.
4. If it is still missing, a simplified summary-only repair request is made.
5. If the provider/model is temporarily unavailable, an extractive, source-grounded fallback summary is created from the saved bio/captions.
6. The enrichment job continues; it is not paused with “Модель ответила, но ни один конспект...” just because JSON/grounding validation was too strict.

## Important validation change

The old evidence gate compared the Russian summary directly with the original profile text. For a Dutch/English/etc. profile this could produce zero lexical overlap even when the summary was correct.

v8 stores `evidence_quotes` — short verbatim source fragments — and accepts multilingual summaries when their facts/quotes are grounded in the original profile.

A summary can still be rejected if it is genuinely generic and has no source evidence. It then enters the repair/fallback path instead of failing the whole job.

## No-data profiles

A profile with no readable bio or captions is not an AI error. It is left as `none` without a red `enrich_error` and does not pause the entire job.

## Version

`ENRICH_VERSION = 8`

All old enrichment notes are considered stale and should be regenerated before being used for new personalized DMs.
