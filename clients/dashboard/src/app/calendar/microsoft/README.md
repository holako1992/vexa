# `src/app/calendar/microsoft/` — Microsoft's OAuth redirect namespace

Holds only `callback/` (DB-32/DB-33) — the exact path `MICROSOFT_CALENDAR_REDIRECT_URI` is set
to. Its own segment, sibling to `../google/`, so Google's and Microsoft's OAuth callbacks never
share a route.
