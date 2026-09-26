# `src/app/upcoming/` — the Upcoming page

`/upcoming` (DB-33): every planned meeting, grouped by day, soonest first — calendar-synced or
hand-scheduled alike, in one `GET /api/vexa/meetings` read (the core's own list, filtered to the
`"scheduled"` phase already defined in `lib/meetings.ts`; never a second source or a client-side
merge across endpoints). The view itself lives in `src/components/UpcomingView.tsx` — this file
only resolves the signed-in user and composes it inside `Shell`, the same split every other route
in `src/app/` uses.

Per row: the source calendar's chip (absent on a hand-scheduled plan), the Join / Don't join
override (a real `Toggle`, `PATCH /api/vexa/meetings/<id> {auto_join}`), and the producer's own
auto-join skip/failure reason (`data.auto_join_error`) verbatim when one was recorded. "Sync now"
runs the existing per-connection sync across every connected calendar, then reloads the list.
