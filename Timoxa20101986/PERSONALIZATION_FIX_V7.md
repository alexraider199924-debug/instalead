# Personalization fix v7

## Changes
- Removed the manual preview/AI-QA launch warning path. Launch now generates a preview automatically for a selected audience contact when the preview is missing, stale, or unapproved.
- Campaign creation remains blocked if the automatic preview does not pass QA; the user is not asked to manually regenerate it.
- Resolved contradictory generation instructions: the prompt now consistently requires a JSON package with `final_message` inside it.
- Requests structured JSON output from OpenRouter for both generation and independent QA, with the existing transport fallback when a provider does not support JSON mode.
- Malformed model output can no longer leak a JSON envelope such as `personalization_hook` into the message preview. It is rejected and retried; if all attempts fail, no malformed output is exposed as a sendable DM.
- Added tests for malformed JSON isolation, valid structured output, and prompt-format consistency.

## Verification
- Personalization tests: 11/11 passed.
- Backend syntax check: passed.
- Full backend test suite could not run because the environment lacks the `express` dependency.
- Frontend production build was not run because frontend dependencies are not installed in this environment.
