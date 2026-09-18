# `src/components/__tests__/` — render tests

Two files, covering the component behaviour a type signature cannot state. Both mock `fetch`
outright: these assert what the UI does with an answer, never that a backend gives one.

- `SendBotDialog.test.tsx` — the dispatch door. Both tabs render; a parsable meeting URL surfaces
  its platform chip and arms the Send button; an unparsable one leaves the button disabled, so a
  malformed link cannot reach `POST /bots`. The Calendar tab lists the connections the API
  returned.
- `MeetingDetail.test.tsx` — one meeting, read by row id. The page requests its own meeting and
  never the collection. The two failure modes stay distinct: a 404 is "not yours or not there"
  and renders not-found, while a 5xx or a dead socket is "we could not ask" and renders the error
  state with retry. Collapsing the second into the first is the bug this file exists to prevent.

Run: `npm test`.
