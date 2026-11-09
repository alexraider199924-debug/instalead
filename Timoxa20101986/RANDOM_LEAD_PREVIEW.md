# Random lead — exact send preview

The Review & Launch → Message card now has a `Random lead` action.

When personalization is enabled, the button calls the backend personalization engine for the selected random contact and shows the resulting DM. It uses the same AI Agent context, profile summary, contact name, quality gate, spintax expansion, and outbound message normalization as the extension send path.

If the user launches the campaign without changing the relevant campaign/AI settings or the lead's summary, the generated preview is persisted on that campaign lead as `message_sent`, so that exact preview is the message sent.

If the campaign or AI Agent settings change after the preview, the UI marks the preview as stale and it is not reused on launch; the normal send path generates a fresh message instead.

Template-only campaigns continue to preview locally using the exact outbound template/name substitution.
