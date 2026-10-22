- **Transcription settings in the dashboard.** A new `/settings/transcription` page (in the main
  navigation) edits the account's default bot name — the same `bot_name` on `/user/calendar` that
  the first-run welcome sets and every bot sent without a name joins under — and the transcription
  service: this Vexa's own, or your own OpenAI-compatible endpoint with a write-only token
  ([`/user/transcription`](/api/settings#transcription-backend)). Switching back to this Vexa's
  service clears your endpoint and its token together. Language is still chosen per bot; there is
  no account-wide default language or transcription model.
