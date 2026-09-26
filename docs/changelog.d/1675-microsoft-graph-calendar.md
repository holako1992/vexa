- **Connect Microsoft 365 Calendar in one consent screen (#1675).** DB-32 adds a Microsoft Graph
  OAuth calendar connection (`kind: "microsoft"`) beside the existing Google OAuth and
  secret-ICS-address ones: `GET /user/calendars/microsoft/authorize` mints a signed, single-use,
  short-TTL consent URL, `POST /user/calendars/microsoft/exchange` completes it server-side (the
  OAuth client secret never leaves admin-api, and the refresh token is encrypted at rest with the
  same AES-256-GCM construction Google's already uses — never stored in the clear). meeting-api's
  calendar sync gains a Microsoft Graph adapter beside the ICS and Google ones, extracting Teams
  (and Meet/Zoom, when present) join links into identical planned-meeting rows for an equivalent
  event; a revoked or expired Microsoft grant surfaces as a visible `reconnect_needed` state
  instead of a silent sync failure. See [Calendar sync](/how-to/calendar-sync) for the exact Azure
  app-registration setup a self-host needs.
