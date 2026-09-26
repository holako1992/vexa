- **Connect Google Calendar from the dashboard, no ICS address needed (#1674).** DB-31 adds a
  **Connect Google Calendar** button as the primary action on the "Add Bot" dialog's Calendar tab:
  it fetches `GET /user/calendars/google/authorize`, checks the returned `authorize_url` is really
  `https://accounts.google.com` before ever redirecting there, and a new
  `/calendar/google/callback` page relays Google's `code`/`state` to
  `POST /user/calendars/google/exchange` on return. State is checked exactly once, by the core
  (signature, TTL, caller binding, single-use) — the dashboard never invents a second, weaker check
  of its own. Denied consent (`error=access_denied`), a state the core doesn't recognize, and the
  exchange call itself failing each surface that producer's own message verbatim, with a **Back to
  Calendar** button that always leaves a way forward. A connection with `reconnect_needed: true`
  shows a **Reconnect** action that re-runs the same flow and clears the flag on success. **Other
  calendar (ICS)** remains as the fallback, now with an inline setup guide and admin-api's own
  validator messages surfaced as per-field hints instead of a generic banner. Both new upstream
  paths are on the dashboard's own closed allowlist, with an exact `{code, state}` body shape check.
  See [Calendar sync](/how-to/calendar-sync) for the updated walkthrough.
