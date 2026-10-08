# `e2e/specs/` — the browser specs (DB-02, extended by DB-04)

Every file proves one property from the DB-02 acceptance table against a REAL running dashboard
and a REAL running stub backend (`../stub-server.mjs`) — no mocked `fetch`, which is what every
other test in this package uses instead. `helpers.ts` holds everything shared across them so each
spec's body is only the property, not the plumbing.

- `helpers.ts` — not a spec. `resetStub()` (call in every `beforeEach`), `signIn()` (drives the
  real email-login form), `testEmail()` (one address per spec so users/tokens don't collide), and
  thin readers over the stub's `/__control/*` remote control (`gatewayRequests`, `adminRequests`,
  `dispatchedBots`) plus the forced-failure setters used by `09-failure-states.spec.ts` and, for
  DB-75, `setEntitlements()` (swap the stub's `GET /user/entitlements` answer) and
  `forceBotsQuotaExceeded()` (make `POST /bots` answer the unwrapped 402 `quota_exceeded` body).
  DB-44/DB-48 add `forceSearch()` (same shape, for `GET /transcripts/search`) and
  `setMeetingStatus()` (flip one fixture meeting's status directly, so the pagination-poll spec
  doesn't need a real bot lifecycle to prove a live row stays visible). DB-74b adds
  `setStripeCustomer()` (set/clear whether the stub account has a Stripe customer on file, so
  `17-billing-upgrade-manage.spec.ts` can reach `POST /billing/portal`'s success path directly,
  without first driving a real checkout).
- `01-gate.spec.ts` — an anonymous page request redirects to `/login`; an anonymous
  `/api/vexa/*` request is a 401, not a redirect (a fetch caller can't follow one).
- `02-signin.spec.ts` — the email door lands on the meetings list and sets both session cookies.
- `03-list.spec.ts` — the fixture meetings render, the phase tabs filter, search narrows.
- `04-detail.spec.ts` — the property `b92d8de1` bought and nothing had yet run: opening a meeting
  requests `GET /meetings/<id>` and never the bare `GET /meetings`; a foreign id is a 404 from the
  gateway, not a list scan that came up empty.
- `05-send-bot.spec.ts` — paste a Google Meet URL, see the parsed platform chip, send, and the
  stub receives exactly that `platform` / `native_meeting_id` pair on `POST /bots`.
- `06-calendar.spec.ts` — connect an ICS calendar (`POST /user/calendars`), then flip its
  auto-join switch (`PATCH /user/calendars/<id>`).
- `07-allowlist.spec.ts` — a path the proxy does not admit (`/recordings`, `/agent/chat`) is a 404
  from the DASHBOARD, and the stub gateway's request log gains no entry for it — the failure mode
  this guards against is a probe that gets silently FORWARDED, not the 404 itself.
- `08-key-safety.spec.ts` — the minted token is `httpOnly`, absent from `document.cookie`, and
  never echoed in a response body; neither is the admin-api key.
- `09-failure-states.spec.ts` — a forced 500 on `/meetings` shows the list's error state with
  retry (never "No meetings yet."); a forced 404 on `/meetings/<id>` shows not-found, not the
  generic error banner — the distinction `EmptyState.tsx` exists to make possible.
- `10-a11y-keyboard.spec.ts` (DB-04) — the accessibility claim, proven with Playwright rather than
  a Lighthouse score this harness has no way to run honestly (nothing here adds a dependency to
  measure one — see the note below). The whole Add Bot flow completes with no mouse click inside
  the dialog; opening it traps focus (fifteen Tabs never escape the panel) and Escape returns
  focus to the "Add Bot" button that opened it; the calendar auto-join control is a real
  `role="switch"` and Space toggles it.
- `11-mobile-viewport.spec.ts` (DB-04) — the meetings list and a meeting's detail page both render
  at 375×812 with no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), and
  the rail drawer opens/closes without causing any. Drawer presence is asserted with
  `toBeInViewport()`, not `toBeVisible()` — the closed rail is translated off-canvas, not
  unmounted, and a CSS transform doesn't zero out the bounding box Playwright's plain visibility
  check looks at, so `toBeVisible()` would pass even while the drawer sits off-screen.
- `12-summary.spec.ts` (DB-60, dashboard half) — the summary panel's five states, each against a
  different fixture meeting (live, shared, completed-but-pending, skipped, complete), plus the
  security property `upstream.ts`/`route.ts` exist for: a same-origin request carrying an
  attacker-controlled `?path=` on the summary route still only ever produces the fixed
  `path=meetings/<id>/summary.md` upstream call — proven by reading the stub's own request log,
  not just asserting the UI never sends one.
- `13-meeting-controls.spec.ts` (DB-41, DB-42) — stop recording (confirm dialog → `DELETE
  /bots/<platform>/<native>`), inline rename (→ `POST /meetings/<id>/annotate`, explicitly NOT
  `PATCH`), delete (confirm dialog names what is lost → `DELETE /meetings/<id>` → back on the list
  with a toast), the participants roster rendering in the header, and a shared meeting showing
  none of rename/delete/stop.
- `14-billing-paywall.spec.ts` (DB-74, DB-75) — the billing page (`/billing`) in each entitlements
  state (free with room left, free exhausted, pro unlimited, usage unknown never rendering as
  `0`); the Send-Bot dialog's remaining-allowance line; a refused send (`POST /bots` → DB-72's
  unwrapped 402 `quota_exceeded`) showing the paywall message with a link to `upgrade_url` (or
  `/billing` when the producer sent none); and the summary panel's emphasis fix — `_none recorded
  in this meeting._` rendering as italic, not literal underscores.

- `15-pagination.spec.ts` (DB-48) — "Load more" appends the fixture's second page (25 rows total,
  page size 20) and then hides itself once a short page proves there is no third; the button is
  reachable and activated by the keyboard alone; no tab carries a numeric badge, only the one
  honest "N loaded" line; a meeting that only becomes live AFTER it was loaded via "Load more"
  (so it sits beyond page one) is still shown live once the phase-aware poll re-fetches — proving
  the poll re-fetches the WHOLE loaded window, not just page one; and the poll's own `GET
  /meetings` request carries `limit=<rows currently loaded>`.
- `16-search.spec.ts` (DB-44) — `Ctrl+K` focuses the shell's search box from the meetings list and
  Enter navigates to `/search?q=`; results are grouped by meeting (the fixture's two meetings that
  both mention "calendar" prove grouping, not flattening) with the matched term wrapped in a real
  `<mark>`; a hit's link carries `?t=<start>` and clicking it scrolls to and highlights the exact
  transcript segment on the meeting page; no matches renders the empty state (not a blank page or
  "no meetings"); a forced failure renders the error state with retry; the loading state is shown
  while the request is in flight; and a request-log proof that `q` never reaches `GET /meetings`
  while it does reach `GET /transcripts/search` intact.

- `17-billing-upgrade-manage.spec.ts` (DB-74b) — clicking Upgrade on a plan card sends the exact
  `{plan, interval}` the card and the monthly/yearly toggle say (proven by the returned Checkout
  URL, which the stub encodes the received body into — see `stub-server.mjs`) and the browser
  navigates there; Manage subscription redirects to the Portal when the account has a Stripe
  customer on file, and shows an explanatory toast (never a generic error) with a live Upgrade
  button still on the page when the core answers 409 because it doesn't; every button on the page
  disables while its own request is in flight. Every navigation to `checkout.stripe.com`/
  `billing.stripe.com` is intercepted with `page.route()` and fulfilled locally — this spec never
  leaves the test environment.

- `18-microsoft-calendar.spec.ts` (DB-32/DB-33) — the Google flow's Microsoft sibling: connecting
  with no text entry at all against `login.microsoftonline.com` (intercepted, never a real
  navigation), denied consent, a state the stub never issued, the exchange call itself failing,
  and a connection needing reconnect showing Reconnect and clearing on success — each proven the
  same way `06-calendar.spec.ts` proves it for Google. Also proves the two providers' busy states
  are independent: clicking Connect Microsoft 365 never disables Connect Google Calendar.
- `19-upcoming.spec.ts` (DB-33) — `/upcoming` groups the fixture's scheduled meetings by day,
  soonest day and soonest meeting within a day first; a calendar-managed row shows its source
  chip and a hand-scheduled one shows none; a recorded auto-join skip reason renders verbatim;
  flipping a row's Join / Don't join switch sends exactly `{auto_join: false}` to
  `PATCH /meetings/<id>` (proven by reading the exact body off the stub's own request log — see
  `helpers.ts`'s `LoggedRequest.body`); and "Sync now" with no calendars connected says so rather
  than doing nothing silently.
- `20-calendar-health.spec.ts` (DB-34) — `/calendar` with nothing connected points at the Add Bot
  dialog's Calendar tab rather than a placeholder; a healthy ICS connection reads "Never synced"
  until "Sync now" gives it a real timestamp and an event count; a failed feed shows the
  producer's `last_error` verbatim with "Sync now" still offered (an ICS feed is never
  `reconnect_needed`); and a Google connection needing reconnect shows Reconnect instead of
  Sync now, driving the SAME OAuth flow `06-calendar.spec.ts` proves, and clears on success.
- `21-recordings.spec.ts` (DB-50/51/52) — `/recordings` lists the fixture's one recording and
  links to its meeting; the retention note reads the plan's own `recording_retention_days`; the
  meeting page's `<audio>` element gets back a REAL `206 Partial Content` with `Content-Range`/
  `Accept-Ranges` for its own Range request (`stub-server.mjs`'s `serveRangeableBytes`, never a
  canned header); clicking a transcript segment seeks the player to its own `start` (proven by
  reading the audio element's real `currentTime`, waited for past the browser's own metadata-load
  race) and highlights it while playing; the Download link points at the exact
  `.../media/<id>/download` URL and actually serves `audio/wav` bytes; and Delete goes through the
  same confirm-dialog-then-toast shape `13-meeting-controls.spec.ts` proves for a meeting, ending
  on the list's own empty state once the one fixture recording is gone.
- `22-signup-refusal.spec.ts` — a disposable-domain address through the email door shows the fixed
  refusal sentence (never admin-api's JSON) and sets no session cookie; `/login?error=<code>` shows
  the copy for a known code and only the generic sentence for anything else, so a hostile value is
  never reflected; and the stub's admin-api log shows the caller's `X-Forwarded-For` on
  `POST /admin/users`. The stub refuses addresses whose local part starts with `disposable`.
- `23-identity-provenance.spec.ts` — the email door's create call carries `identity_provider: "email"`
  and `email_verified: false`, and a returning email-door sign-in sends no provenance update; an
  account whose entitlements state `identity_unverified` sees the fixed explanation on `/billing` and
  in the Send Bot dialog (allowance line and the 402 refusal, which carries no plan link) and never
  the raw code.
- `24-export.spec.ts` — each Export format downloaded from meeting 102 and read back: SubRip and
  WebVTT cues per line, Markdown and text in order, a .docx package holding every line; "Copy as
  Markdown" on the clipboard; PDF calls the print dialog, and under print media the transcript
  stays while the rail, Export button, search box and back link are hidden.
- `25-speaker-names.spec.ts` — naming "Dev" sends exactly `{metadata: {speaker_labels: {Dev:
  "Devon Lee"}}}`, renames both of Dev's lines and only those, survives a reload, rides into the
  text export, and clearing it sends `null`; a forced 500 keeps the dialog open with nothing
  renamed; a hand-made annotate body naming another metadata key is a 400 that never reaches the
  gateway.
- `26-tags.spec.ts` — the tag chip asks the gateway for `metadata={"tags":["acme"]}` on every list
  request and shows exactly the two tagged meetings; an unknown tag says so; adding "  Q3   Planning "
  stores "q3 planning", removing the last tag sends `null`, and the row's other metadata key
  survives; a failed write leaves the chips as they were; a shared meeting shows tags without an
  editor; sorting by title keeps the live meeting first.
- `27-live-transcript.spec.ts` — DB-40 on live meeting 101: streamed lines appear inside 2s with no
  `GET /transcripts/by-id` re-read across a poll interval (the row is still re-read); a draft
  refined then confirmed is one line, a retract removes it, a saved speaker name applies; a drop
  that comes back refused shows "polling" and re-reads REST every 5s, then streams again once the
  feed is back; a feed absent from the start polls from the first load; a drop reconnects with a
  `<id>|$|0-0` `Last-Event-ID` and the gap's line arrives exactly once; the page follows the live
  end, scrolling up shows "Jump to live" and stops following, the button brings the reader back;
  `meeting-end` ends the live view, reloads the transcript and nothing reconnects; the allowlist
  refuses every non-numeric or near-miss stream path and the POST without a gateway call, drops
  the caller's query and a malformed `Last-Event-ID`, and forwards a well-formed one.
- `28-meeting-chat.spec.ts` — DB-61's chat against the stub's `/agent/chat`, which answers the way
  the gateway relays agent-api (always `200 text/event-stream`). The first words of an answer are
  on screen while the stub still holds the stream open, the rest after release, `**Friday**` as a
  real `<strong>`; the body the gateway receives is exactly the meeting-scoped shape for row 102;
  Stop closes the stream (the stub counts a connection dropped before the turn finished); no
  model credential, a model failure, agent-api not wired, agent-api down (an empty 200) and no
  agent domain (a 404) each end as a sentence, never a spinner; New conversation resets
  `dashboard-meeting-102`; `/search` sends the across-meetings shape with no focus; shared meeting
  104 has no chat; hand-made bodies outside the panels' shapes are 400s that never reach the
  gateway; and the panel opens, asks and closes (focus back on its button) from the keyboard.
  Proved against a buffering proxy as a negative control: the streaming and Stop tests fail.
- `29-account.spec.ts` — `/settings/account`: email, initials, the recorded sign-in door and one
  session per `dashboard-login` token render; Sign out everywhere (behind a confirmation) leaves
  only the person's own `my-ci-key` token at the core, clears this browser's cookies, lands on
  `/login` with a plain notice, and a second signed-in browser's next `/api/auth/me`,
  `/api/vexa/meetings` and `/api/account` are 401s and its next page is `/login`; cancelling does
  nothing; a revoke the core refuses is a sentence and leaves the browser signed in; a body, query
  or path naming another user is ignored and that user's token survives; a cross-origin write is
  403 and an anonymous caller 401; a live session is bounced off `/login` while a revoked one gets
  the form (a cookie-only bounce would loop a revoked session between `/login` and the page).

- `31-delete-account.spec.ts` — Delete account: the page lists what is erased; the dialog's Delete
  stays disabled until the typed email matches (trimmed, any case) and Cancel sends nothing; a
  hand-made wrong or missing confirmation is a 400 that never reaches admin-api; a confirmed delete
  removes the user at the stub core, clears the cookies, lands on `/login?notice=account-deleted`,
  refuses a second browser, and the same address signs in to a new empty account; a partial the core
  keeps returning is retried 3 times and said in plain words (never "deleted"), one the retry
  finishes is a success; a 409 shows a fixed sentence and changes nothing; a body, query or path
  naming another user is ignored and that user survives; cross-origin is 403, anonymous 401; the
  fourth guess in ten minutes is 429; the dialog fits 375x812 and works from the keyboard.

- `30-first-run.spec.ts` — DB-20: who is welcomed (a new account with no meetings; not one with
  meetings, not one that is not new, not an ended welcome, not an unreadable answer), the bot
  name saved as the default and said by the send form, a refresh resuming the step, Skip setup from
  every step saved and final, Escape hiding for the visit only, the calendar consent round trip
  (and a declined one) landing back inside the welcome, a fresh account reaching its first meeting
  page in three clicks (jump to the last step, Send Bot, Open meeting), the allowance stated up
  front and a spent or unverified one explained with the calendar still on offer, keyboard
  operation, and 375px.

**On Lighthouse:** DB-04's brief names a Lighthouse a11y score. This repo has no Lighthouse CI
wired in and adding `lighthouse`/`@lhci/cli` would be a new dependency this task's own constraints
(no new runtime dependency without justification) argue against pulling in just to print one
number. `10-a11y-keyboard.spec.ts` above asserts the underlying properties a Lighthouse a11y audit
actually checks for this surface — accessible names and roles, keyboard operability, focus
management — directly, which is verifiable in CI without a score nobody re-measures. No Lighthouse
number is reported anywhere in this tree; treat any that shows up as unmeasured.

Run: `npm run test:e2e` from `clients/dashboard/` (needs `npx playwright install chromium` once;
see `../README.md`).
