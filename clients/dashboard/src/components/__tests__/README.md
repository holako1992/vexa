# `src/components/__tests__/` — render tests

Three files, covering the component behaviour a type signature cannot state. Both mock `fetch`
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
  none of these tests exercises the highlight for. DB-40 adds the live case: a live row's
  streamed segments (a scripted `text/event-stream` body) land on the REST transcript by segment
  id — a REST draft replaced by its confirmed text, a new segment appended, two lines not three —
  under the speaker's saved name, with the status line reading `streaming`.
- `EmptyErrorStates.test.tsx` — "could not ask" and "you have none" stay apart on the surfaces
  that read on their own: a failed participants read or audio read shows an alert with a retry that
  recovers, while an empty roster, a participants 404 and a recording with no audio file show no
  alert at all; the Upcoming page's Sync now reports an unreadable calendar roster as a failure,
  never as "No calendars connected"; a failed plan read on `/billing` retries into the plan.
  `emptyListCopy` gives each meetings tab, tag and filter its own words and next action, so a
  filter that matched nothing never tells someone with meetings to send their first bot.

Run: `npm test`.
