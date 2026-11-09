# Personalization AI QA update

## What changed

- Added an independent AI review pass after the deterministic personalization checks.
- The reviewer receives the lead's full profile summary, the canonical offer, the selected personalization hook, and the complete candidate DM.
- It evaluates whether the fact is specific and grounded in the summary, whether it naturally leads into the offer, whether the offer/CTA remain intact, and whether the message is concise and natural.
- Rejected drafts feed the reviewer's concrete correction back into generation. Generation now gets up to three attempts.
- The preview API returns `qa_review` (`approved`, `score`, `reason`, `fix`) and `qa_attempts`.
- Campaign review displays the QA result and allows regenerating for the same lead.
- Personalized campaigns cannot launch unless the current preview is QA-approved.
- The actual extension send endpoint also refuses to send a generated message when QA did not approve it.
- An approved preview for a selected lead continues to be stored as the exact message that will be sent to that lead.

## Verification

- Backend syntax check passes.
- Existing personalization greeting tests pass (3/3).
- Frontend production build could not be run in this environment because frontend dependencies (`vite`) are not installed.

## Note

AI review adds an extra model call for candidates that pass deterministic checks. It is deliberately fail-closed: if the reviewer cannot validate a candidate after retries, the message is not approved for sending.
