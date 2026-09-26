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

**On Lighthouse:** DB-04's brief names a Lighthouse a11y score. This repo has no Lighthouse CI
wired in and adding `lighthouse`/`@lhci/cli` would be a new dependency this task's own constraints
(no new runtime dependency without justification) argue against pulling in just to print one
number. `10-a11y-keyboard.spec.ts` above asserts the underlying properties a Lighthouse a11y audit
actually checks for this surface — accessible names and roles, keyboard operability, focus
management — directly, which is verifiable in CI without a score nobody re-measures. No Lighthouse
number is reported anywhere in this tree; treat any that shows up as unmeasured.

Run: `npm run test:e2e` from `clients/dashboard/` (needs `npx playwright install chromium` once;
see `../README.md`).
