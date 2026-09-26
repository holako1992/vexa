# `src/app/calendar/google/` — Google's OAuth redirect namespace

Holds only `callback/` (DB-31) — the exact path `GOOGLE_CALENDAR_REDIRECT_URI` is set to. Its own
segment (rather than flattening to `src/app/calendar/`), sibling to `../microsoft/`, so Google's
and Microsoft's OAuth callbacks never share a route.
