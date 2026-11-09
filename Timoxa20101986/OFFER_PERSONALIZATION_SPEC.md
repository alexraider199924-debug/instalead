# AI Agent — offer-first personalization specification

## Canonical rule
When `sample_message_mode = offer_template`, the AI Agent example is the canonical offer. The model may personalize it, but must not replace it with a new sales pitch.

### Allowed
- Insert one concrete, verified profile detail.
- Make small wording changes according to the selected variation mode.
- Preserve the original intent, CTA and order of the offer.
- Use the contact's saved name from `Contacts`.
- Preserve the greeting from the canonical offer (Yo/Hey/Hi/etc.). If the offer has no greeting, prepend a short greeting + saved contact name.

### Forbidden
- Rebuild the message from `company_description`, `problem_solved`, `result_created`, `proof`, `how_it_works`, `offer_hook`, or `message_structure` when those fields conflict with the canonical offer.
- Invent a pain point for the lead.
- Turn a short opener into a long company presentation.
- Use Instagram username or scraped display name as the contact's name.

## Contact name
The `Contacts.full_name` value is the single source of truth. The AI Agent no longer has a setting for whether to use the name. The name is always used when present.

## Removed controls
The following AI Agent controls were removed because they distorted the generator instead of improving quality:
- Message length in characters.
- Profile summary length in words.

The summary keeps a fixed internal cap; message length is determined by the canonical offer.

## Quality gate
For strict offer mode, generated text must:
- start with a greeting + saved contact name;
- contain a grounded profile detail when enrichment is strong;
- retain a minimum lexical overlap with the canonical offer;
- retain a CTA/question;
- avoid generic banned openers and invented claims.

If the model still fails after retries, the backend builds a deterministic fallback from the canonical offer + the generated personalization hook. This prevents a failed generation from silently becoming a completely different sales pitch.
