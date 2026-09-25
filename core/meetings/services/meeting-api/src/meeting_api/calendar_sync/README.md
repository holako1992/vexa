# calendar_sync — ICS feed / Google Calendar API → planned meetings

One concern: turn a user's connected calendar (a secret ICS feed, or — since DB-30 — an OAuth
Google Calendar connection) into PLANNED meeting rows (intent status `scheduled`, complete
`data.calendar_sources[].event` provenance) so the Meetings surface shows what's coming and the
auto-join sweep sends the bot when each meeting starts. The ICS path needs no OAuth: the user
pastes the secret-address ICS URL Google Calendar / Outlook already provide (`PUT /user/calendar`,
identity domain). The Google path is one consent screen (`google_oauth.py`, identity domain) —
meeting-api never sees the client secret or the refresh token, only a short-lived access token
minted per sync by identity's internal edge.

## Public surface
- `parse_ics(text, now, horizon_days=14)` → `{"events": [PlannedEvent], "cancelled_uids": […]}`
  (pure). **One event per UID — the next upcoming occurrence only** (a recurring meeting reuses one
  link; two active rows on one native id would violate `uq_meeting_active_user_platform_native`).
  Every event carries a JSON-safe snapshot of all VEVENT properties, parameters, nested components,
  top-level VCALENDAR properties, and the series master for an override. Link-less events still
  import honestly; only recognized Meet/Zoom/Teams links arm auto-join.
- `parse_google_events(events, now, horizon_days=14)` (service.py) — the SAME PlannedEvent shape,
  from Google Calendar API `events.list(singleEvents=true)` items. Groups by `recurringEventId`
  (falling back to `id`) and keeps only the earliest in-window occurrence — Google's own expansion
  of a recurring series, folded back to "next occurrence only" the same way the ICS RRULE expansion
  is. Link extraction reuses the ICS path's `find_meeting_link` (hangoutLink → conferenceData video
  entry point → location → description), so an identical link resolves identically either way.
- `sync_user(store, user_id, parsed, auto_join_default, …)` → upserts through the SAME planned-meeting
  store primitives `POST /meetings` uses (advisory-locked), fed by EITHER parser above — this is
  what makes an equivalent ICS and Google event produce an identical row. Intent rows follow the
  feed; FSM rows are never touched; a manual plan on the same link is ADOPTED (uid stamped), not
  duplicated; vanished/cancelled UIDs retire their still-planned rows. Two rules the whole-row
  semantics rest on: `auto_join` is DERIVED from the connected calendars' policy **unless** the
  user pinned it on that row (`data.auto_join_user_set`, written by `PATCH /meetings/{id}`), and
  rows imported before plural calendars — bare `data.calendar_uid`, no sources — are claimed only
  by the `legacy=True` connection, which is also the one that may retire them.
- `fetch_ics(url, client=None)` — **SSRF-pinned** (`webhooks/ssrf.build_pinned_transport`), 2 MB cap,
  no redirects; pass a `build_ics_client()` to share one connection pool across a sweep.
  `fetch_configs(admin_api_url, secret)` — the internal discovery hop (ICS AND Google configs alike;
  a Google config never carries a credential over this edge). `fetch_google_access_token(admin_api_url,
  secret, user_id, calendar_id)` mints a short-lived Google access token via identity's internal
  edge — a `409` there means the grant is revoked/expired, threaded through as `reconnect_needed`.
  `fetch_google_events(access_token, calendar_ids, time_min, time_max, client=None)` — paginated
  `events.list`, fail-loud on the first calendar's error (never a partial silent result).

## Wiring (entrypoint)
`meeting_api.__main__._attach_background_loops` runs one sweep per `CALENDAR_SYNC_INTERVAL_S`
(default 300 s): configs → grouped by user → up to `CALENDAR_SYNC_CONCURRENCY` users at a time,
each reading its meeting rows ONCE and threading them through that user's calendars over one shared
pinned client (per-user try/except — one bad feed never stalls the sweep) → WS frames per changed
row → `cal:sync:{user_id}` redis stamp (`last_sync`/`last_error`/counts, read back by the terminal's
calendar popover). A config arrives in one of three shapes: live (feed URL, or `kind: "google"`),
`deleted` (tombstone), or `paused` (`enabled: false`) — the latter two parse as an empty feed, so a
disconnected or paused calendar leaves no meeting armed. Unset `ADMIN_API_URL`/`INTERNAL_API_SECRET`
→ the loop no-ops (capability degrade, not boot-fail); a Google config additionally no-ops (with a
named `last_error`) if those two are unset, since the access-token mint needs identity's internal edge.

## Dependencies
`icalendar` + `python-dateutil` (both FINOS Category A), imported lazily. Depends on
`collector` (meeting_link + the planned-meeting store port) and `webhooks.ssrf` only.
