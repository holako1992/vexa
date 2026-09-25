- **Connect Google Calendar in one consent screen (#1646).** DB-30 adds a Google OAuth calendar
  connection beside the existing secret-ICS-address one: `GET /user/calendars/google/authorize`
  mints a signed, single-use, short-TTL consent URL, `POST /user/calendars/google/exchange`
  completes it server-side (the OAuth client secret never leaves admin-api, and the refresh token
  is encrypted at rest — never stored in the clear). meeting-api's calendar sync gains a Google
  adapter beside the ICS one, producing identical planned-meeting rows for an equivalent event; a
  revoked or expired Google grant surfaces as a visible `reconnect_needed` state instead of a
  silent sync failure. See [Calendar sync](/how-to/calendar-sync) for the exact Google Cloud
  Console setup a self-host needs.
