# Personalization update v6

- Added example-driven Russian DM guidance based on the user's 30 examples: one concrete profile hook, natural transition, relevant question, current campaign offer, and one CTA.
- Examples are explicitly style-only. The model must never copy facts from sample leads and must always use the current lead summary and campaign offer.
- Added encoding-corruption detection for Unicode replacement characters and common mojibake patterns. Corrupted output is rejected and fed back into automatic repair; after retries the pipeline does not treat it as approved.
- Added regression tests for replacement characters and mojibake.

Validation: backend syntax check passed; 19 targeted tests passed. Full suite: 19 passed, 1 could not run because the environment does not have the `express` dependency installed.
