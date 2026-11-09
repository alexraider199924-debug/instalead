# Personalization runtime fix — 2026-10-06

## What changed

### 1. DOM is no longer blocked by the LLM
`POST /contact-enrich/task/:id/scraped` now acknowledges the scraped profiles immediately. AI summarization starts asynchronously after the response is sent.

This removes the failure mode where the extension waits for OpenRouter, the request times out, and the DOM enrichment worker appears to crash.

A per-job lock prevents two summary passes from running concurrently. The task endpoint also stops issuing another Instagram scrape batch while the current AI pass is running.

### 2. Claude Sonnet 5 is fixed for the personalization pipeline
Both stages of the personalization pipeline are pinned to:

`anthropic/claude-sonnet-5`

- profile enrichment / Lead Intelligence
- final personalized DM generation

The generic model selected in Integrations remains available to other AI features, but it cannot silently replace Claude Sonnet 5 for this pipeline.

OpenRouter remains the transport/API gateway.

### 3. Enrichment batches are smaller and have more output headroom
- batch size: 5 → 3 profiles
- batch output budget: 1200 tokens/profile
- single-profile retry: 2200 tokens
- dense rewrite: 1800 tokens
- reasoning-only retry ceiling: 8000 tokens
- HTTP timeout: 60 seconds

The goal is to avoid truncating a structured multi-profile response before the JSON is complete.

### 4. Version bump
`ENRICH_VERSION` is now `7`, so notes created under the previous enrichment contract are treated as stale.

## Expected behavior

1. Extension scrapes 3 profiles.
2. Backend immediately returns `success: true` to the extension.
3. The browser/DOM worker continues normally.
4. Backend generates Lead Intelligence with Claude Sonnet 5.
5. If Claude returns malformed/partial data, the backend retries individual profiles without blocking the browser.
6. Once summaries exist, the send-side personalization also uses Claude Sonnet 5 and the existing quality gate.
