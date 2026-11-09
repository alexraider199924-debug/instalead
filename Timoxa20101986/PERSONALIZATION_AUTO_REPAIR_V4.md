# Personalization auto-repair v4

## What changed
- Fixed the Russian greeting quality gate. Previously, the gate only accepted English greetings, so a correct `Привет Гаяна, ...` message was rejected before the independent AI reviewer could evaluate it. This caused all repair attempts to repeat the same false failure.
- The greeting gate now accepts supported greetings in the target language, including Cyrillic, and checks that the saved contact name appears only once.
- Added detection of replacement/corrupted Unicode characters so the model receives an automatic repair instruction instead of allowing damaged text through.
- Strengthened generation and reviewer instructions: select one concrete fact from the lead summary, connect it logically to the offer, preserve the canonical offer/CTA, use the name only in the greeting, and remove repeated greetings.
- Increased automatic generation/review/repair attempts from 3 to 5. Preview generation and send-time generation both use the same engine.
- Added regression tests for Russian greetings and repeated names.

## Verification
- `node --check src/services/personalizationEngine.js`: passed.
- `node --test test/personalizationGreeting.test.js`: 5/5 passed.
- Full backend suite: 16 tests passed; one test file could not load because the environment lacks the `express` dependency. Run `npm install` in `backend/` before the full suite.
