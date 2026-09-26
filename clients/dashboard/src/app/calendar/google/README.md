# `src/app/calendar/google/` — Google's OAuth redirect namespace

Holds only `callback/` (DB-31) — the exact path `GOOGLE_CALENDAR_REDIRECT_URI` is set to. Kept as
its own segment (rather than flattening to `src/app/calendar/`) so a later provider (Microsoft,
DB-32) gets its own sibling `microsoft/callback/` without the two ever sharing a route.
