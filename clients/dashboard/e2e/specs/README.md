# `e2e/specs/` — the nine browser specs (DB-02)

Every file proves one property from the DB-02 acceptance table against a REAL running dashboard
and a REAL running stub backend (`../stub-server.mjs`) — no mocked `fetch`, which is what every
other test in this package uses instead. `helpers.ts` holds everything shared across them so each
spec's body is only the property, not the plumbing.

- `helpers.ts` — not a spec. `resetStub()` (call in every `beforeEach`), `signIn()` (drives the
  real email-login form), `testEmail()` (one address per spec so users/tokens don't collide), and
  thin readers over the stub's `/__control/*` remote control (`gatewayRequests`, `adminRequests`,
  `dispatchedBots`) plus the two forced-failure setters used by `09-failure-states.spec.ts`.
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

Run: `npm run test:e2e` from `clients/dashboard/` (needs `npx playwright install chromium` once;
see `../README.md`).
