# `src/components/__tests__/` — render tests

Two files, covering the component behaviour a type signature cannot state. Both mock `fetch`
outright: these assert what the UI does with an answer, never that a backend gives one.

- `SendBotDialog.test.tsx` — the dispatch door. Both tabs render; a parsable meeting URL surfaces
  its platform chip and arms the Send button; an unparsable one leaves the button disabled, so a
  malformed link cannot reach `POST /bots`. The Calendar tab lists the connections the API
  returned. Renders through a local `renderDialog()` helper that wraps in `<ui/Toast>`'s
  `ToastProvider` — `SendBotDialog`'s mutations call `useToast()`, which throws outside one — and
  scopes its confirmation-text assertions to `within(screen.getByRole("dialog"))`, because DB-04
  made that same confirmation text also appear in a toast (a sibling of the dialog); the two are
  independently-timed pieces of UI and a test about one must not accidentally assert on the other.
- `MeetingDetail.test.tsx` — one meeting, read by row id. The page requests its own meeting and
  never the collection. The two failure modes stay distinct: a 404 is "not yours or not there"
  and renders not-found, while a 5xx or a dead socket is "we could not ask" and renders the error
  state with retry. Collapsing the second into the first is the bug this file exists to prevent.
  `next/navigation`'s mock now also stubs `useSearchParams()` (DB-44's `?t=` scroll-to-segment
  link reads it) — returning an empty `URLSearchParams`, i.e. "no query at all", the ordinary case
  none of these tests exercises the highlight for.

Run: `npm test`.
