# Random lead preview fix

The `Random lead` preview endpoint now aliases the request field `message_template`
to `messageTemplateInput` and passes it explicitly as `messageTemplate` to the
personalization engine. This prevents the `messageTemplate is not defined`
ReferenceError that could occur when generating the preview.

The preview still uses the same personalization pipeline as campaign sending.
