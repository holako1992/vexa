# `src/app/calendar/` — the Calendar (health) page, and both providers' OAuth landing pages

`page.tsx` is `/calendar` (DB-34): per-connection health — last sync, last error, events touched,
and a Reconnect action for a connection whose grant needs it. The view itself lives in
`src/components/CalendarHealthView.tsx`. Connecting a NEW calendar still happens in the "Add Bot"
dialog's Calendar tab (`src/components/SendBotDialog.tsx`, DB-31/DB-33) — this page never
duplicates that flow; with nothing connected yet, it points there instead.

`google/` and `microsoft/` hold ONLY each provider's OAuth `callback/` route — the exact paths
`GOOGLE_CALENDAR_REDIRECT_URI` / `MICROSOFT_CALENDAR_REDIRECT_URI` are set to. Neither has a
nav-rail entry of its own; they are reached only from the provider's own redirect.
