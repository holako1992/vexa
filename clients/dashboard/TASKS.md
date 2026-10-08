# Dashboard → production SaaS: the task board

Target: a paid, self-serve meeting-notes product in the shape of Otter.ai / Read.ai, built on the
Vexa core, served by `clients/dashboard` (dev :3001, compose :13002, service `dashboard-next`).

This file is the intake list. One agent claims one task, works it in its own worktree
(`git worktree add ../vexa-<slug> -b <branch>`), and reports evidence per the AGENTS.md loop
(Expected → Actual → Verdict). Tasks are numbered so PRs and issues can cite them (`DB-xx`).

Sizes: **S** ≤ half a day · **M** 1–2 days · **L** 3+ days or cross-domain.

---

## 0. Where we are (code-grounded, 2026-09-18)

What the dashboard does today:

- Meetings list with live/past/upcoming tabs, search, phase-aware polling — `src/components/MeetingsView.tsx`.
- One meeting's transcript by row id, speaker chips, in-transcript search, copy/download — `src/components/MeetingDetail.tsx`.
- Sign-in: Google / Microsoft OAuth via NextAuth, or a dev-only password-less email door — `src/app/api/auth/authOptions.ts`, `src/app/api/auth/login/route.ts`.
- "Add Bot" dialog: paste a Meet/Zoom/Teams/Jitsi URL → `POST /bots`; connect up to 10 ICS calendars → `/user/calendars` — `src/components/SendBotDialog.tsx`, `src/lib/meetingId.ts`.
- One closed allowlisted proxy to the gateway with the user's own key — `src/app/api/vexa/[...path]/route.ts`, `src/lib/upstream.ts`.

**Uncommitted on branch `claude/dashboard-service-modern-xoiy2c`:** `SendBotDialog.tsx`, `meetingId.ts`, and edits to
`route.ts` / `upstream.ts` / `MeetingsView.tsx` / `api.ts`. The bot-dispatch and calendar features exist only in the
working tree. See DB-01.

What the core already offers that the dashboard does not yet use (from `core/*/routes.v1.json`):

| Capability | Route(s) | Status |
|---|---|---|
| Single meeting read | `GET /meetings/{meeting_id}` | exists; dashboard scans the list instead |
| Rename / delete meeting | `PATCH`, `DELETE /meetings/{meeting_id}` | exists |
| Cross-meeting search | `GET /transcripts/search` | exists |
| Share a meeting / accept a share | `POST /meetings/{id}/share`, `POST /transcripts/share/accept` | exists |
| Stop a bot, bot status | `DELETE /bots/{platform}/{native}`, `GET /bots/status` | exists |
| Recordings + range-streamed audio | `GET /recordings`, `/recordings/{id}/master`, `.../raw` | exists, no client player anywhere |
| Participants | `GET /meetings/{platform}/{native}/participants` | exists |
| Webhook config + deliveries | `GET/PUT /user/webhook`, `GET /user/webhook/deliveries` | exists |
| Transcription + model prefs | `GET/PUT /user/transcription`, `/user/models` | exists |
| Agent chat / live stream / notes | `POST /agent/chat`, `/agent/meeting/stream`, `/agent/*` | exists (terminal uses it) |
| Per-user bot ceiling | `User.max_concurrent_bots` (admin-api) → pre-check in `meeting_api/bot_spawn/router.py:213` | exists, default 3 |
| Stripe fields on the user | `PlatformBillingDataPatch` in `admin_api/app/main.py:122` (stripe_customer_id, subscription_tier, period start/end…) | schema only — **nothing writes them**; no Stripe client, no webhook receiver anywhere in the tree |
| Onboarding fact → flows | `onboarding.completed` with `{subject, org, seat}` (`admin_api/app/events.py`) | exists; seat is always `member` |

What does **not** exist anywhere: a plan catalog, an entitlement resolver, a usage meter (meetings or minutes per
period), a Stripe integration, a Google/Microsoft Calendar OAuth connector (calendar sync is ICS-only by design —
`docs/docs/how-to/calendar-sync.mdx`), an email/password or magic-link sign-in, a recordings player, AI summaries in
any web client, a billing page, legal pages, or an end-to-end browser test harness for the dashboard.

---

## 1. Foundation (do first — everything else stacks on it)

**DB-01 · Land the uncommitted dispatch + calendar work** — S
Commit the working-tree files listed above with tests: `resolveWriteUpstream` table in `src/lib/__tests__/upstream.test.ts`,
`parseMeetingInput` cases in a new `meetingId.test.ts`, and a render test for `SendBotDialog`. Update `README.md`'s
"What it deliberately does not do" — it still claims *no bot dispatch*. Drop a changelog fragment
(`docs/changelog.d/<pr>-dashboard-dispatch.md`).
Done when: `npm test` and `npm run typecheck` green; README describes the real surface.

**DB-02 · Browser test harness against a stub gateway** — M
Playwright (MIT) in `clients/dashboard/e2e/`, a stub gateway fixture that serves canned `/meetings`, `/transcripts/by-id`,
`/bots`, `/user/calendars`. Wire into `node scripts/gates.mjs` as a dashboard gate. Every later UI task adds one spec here.
Done when: sign-in (email door), list, detail, send-bot, connect-calendar run green headless in CI.

**DB-03 · Hot-reload compose profile for the dashboard** — S
Mirror the `terminal` block in `deploy/compose/docker-compose.hot.yml` for `dashboard-next` (bind-mount `src/`).
Done when: an edit under `clients/dashboard/src` is visible at :13002 without a rebuild.

**DB-04 · Design system + app shell** — M
Sidebar navigation (Meetings · Upcoming · Calendar · Recordings · Settings · Billing), top bar with account menu,
responsive at 375px, keyboard-navigable, dark/light from the existing CSS variables in `globals.css`.
Extract shared primitives (Button, Input, Dialog, Toggle, Toast, Tabs, Skeleton) into `src/components/ui/`.
`SendBotDialog` and `MeetingsView` migrate to them. No new UI dependency without a licence check (Category A only).
Done when: every existing page renders inside the shell; Lighthouse a11y ≥ 95 on list and detail.

**DB-05 · Use the single-row read and stop scanning the list** — S
`MeetingDetail` calls `GET /meetings` and `find`s the row. Add `meetings/<id>` to `resolveUpstream`, call
`GET /meetings/{meeting_id}`. Done when: the detail page issues one row request; a foreign id is a 404 from the gateway,
not a "not found" derived from a list scan.

---

## 2. Accounts and sign-in

**DB-10 · Real email sign-in (magic link)** — L
Today the only production doors are Google and Microsoft OAuth. Add a passwordless magic-link flow: `POST /api/auth/magic`
issues a single-use, 15-minute signed token, mailed through flows' mailbox (`core/flows/src/flows_integrations/mailbox.py`)
or a Category-A SMTP lib; `GET /api/auth/magic/verify` consumes it and runs the same find-or-create + mint path as OAuth
(`lib/adminApi.ts`). Rate-limited (`lib/rateLimit.ts`), same-origin, no enumeration (identical response for unknown mail).
Retire `DASHBOARD_ALLOW_EMAIL_LOGIN` from production docs; keep it for dev/e2e.
Done when: a user with no Google/Microsoft account can sign up, sign in, and sign out; token table shows one
`dashboard-login` token per session under the cap.

**DB-11 · Account page** — M
`/settings/account`: name, email (read-only), avatar initials, connected identity providers, active sessions with
"sign out everywhere" (revoke all `dashboard-login` tokens via admin-api), delete account (double-confirm; calls the
admin-api user delete; cascades meetings/recordings per the meeting-api erasure path).
Done when: revoke-all makes a second browser's next request 401; delete removes the user row and their rows.

**DB-12 · Email verification + identity oracle always on** — S
Make `VEXA_INTERNAL_API_SECRET` required in the production compose profile (`/api/auth/me` must never report
`verified: false` in prod). Document in README and `docs/docs/deployment.mdx`.

---

## 3. First run and onboarding

**DB-20 · First-run wizard** — M
After the first sign-in with zero meetings: 3 steps — pick the bot's display name (persist via `PUT /user/transcription`
or a user pref), connect a calendar (reuses DB-31), or paste a link for a first meeting. Progress persisted so a refresh
resumes. Skippable.
Done when: a fresh user reaches a first transcript in ≤ 3 clicks from sign-in in the e2e spec.

**DB-21 · Empty and error states audit** — S
Every list, tab and panel has a designed empty state with the next action; every fetch failure distinguishes
"could not ask" from "you have none" (the rule already in `MeetingsView.tsx:64`). Toasts for mutations.

---

## 4. Calendar (the user called this out as not seamless)

**DB-30 · Google Calendar OAuth connector (core)** — L · *core/identity + core/meetings*
Add a second calendar connection kind beside ICS: `{kind: "google", refresh_token(enc), calendar_ids[]}` in
`admin_api/app/calendars.py`; a `calendar_sync` adapter in meeting-api that lists events via the Calendar API
(`calendar.readonly`), producing the same planned-meeting rows the ICS path produces
(`meeting_api/calendar_sync/adapters.py`). Tokens encrypted at rest with the existing request-guard secrets pattern.
Update `core/identity/routes.v1.json`, `architecture.calm.json` + `pnpm seal:arch` (P23), and the calendar API docs.
Done when: a Google account with three future Meet events yields three Upcoming rows after one consent screen and no
ICS address; revoking access in Google makes the next sync report a clear "reconnect" state.

**DB-31 · Calendar connect flow in the dashboard** — M · depends on DB-30
Replace the "Secret ICS address" form as the primary path: **Connect Google Calendar** (one OAuth click, scope
`calendar.readonly`, separate consent from sign-in), **Connect Microsoft 365** (DB-32), and **Other calendar (ICS)** as
the fallback with an inline illustrated guide taken from `docs/docs/how-to/calendar-sync.mdx` and the validator errors
from `calendars.py:26` surfaced as field hints.
Done when: e2e connects a stubbed Google calendar with no text entry; ICS path still works.

**DB-32 · Microsoft Graph calendar connector** — L · *core*
Same shape as DB-30 against Graph `Calendars.Read`. Done when the same three-event test passes with an M365 tenant.

**DB-33 · Upcoming page** — M
Dedicated `/upcoming`: events grouped by day, source calendar chip, per-meeting **Join / Don't join** override
(`PUT /meetings/{platform}/{native}/intent`), per-calendar default bot name (`bot_name` on the connection is already
modelled), and "sync now". Done when a toggled-off meeting is not joined at start time in a live check.

**DB-34 · Calendar health** — S
Show last sync time, last error, and event count per connection (surface what `GET /user/calendars/{id}/sync` returns).
A failed feed shows a reconnect action rather than silently going stale.

---

## 5. Meetings and transcripts

**DB-40 · Live transcript** — M
While a meeting is live, stream segments instead of polling every 5s: proxy `GET /agent/meeting/stream` (SSE) through a
new allowlisted route, fall back to polling when the stream is unavailable. Auto-scroll with a "jump to live" pill.

**DB-41 · Bot controls on the meeting page** — S
Status from `GET /bots/status`; **Stop recording** → `DELETE /bots/{platform}/{native}`; join-failure reasons rendered
verbatim from the producer. Add both paths to the write allowlist with shape checks.

**DB-42 · Rename, delete, participants** — S
Inline title edit (`PATCH /meetings/{id}`), delete with confirm (`DELETE /meetings/{id}`), participants list
(`GET /meetings/{platform}/{native}/participants`) in the header.

**DB-43 · Speaker rename** — M
Rename "Speaker 1" → a person, applied to every segment of that meeting. Persist through
`POST /meetings/{id}/annotate` (verify the annotation shape in `meeting_api/app.py`; if annotate cannot carry a speaker
map, add a `speaker_labels` field on the meeting row in core — fix at the producer, never in the client).

**DB-44 · Global search** — M
Search box in the shell hitting `GET /transcripts/search`; results grouped by meeting with highlighted snippets, keyboard
`⌘K`. Add `q` to `ALLOWED_QUERY`.

**DB-45 · Export** — M
TXT (exists), SRT/VTT with timestamps, DOCX and PDF (server-side render in a Next route; Category-A libs only), and
"copy as Markdown". Done when each export round-trips the same segments the page shows.

**DB-46 · Sharing** — removed from scope 2026-10-08 (user decision). Not planned.

**DB-47 · Tags and folders** — M
User-defined tags on meetings (store in the meeting row's metadata via `PATCH /meetings/{id}`; add a core field if the
row has no free-form slot). Filter chips on the list. Sort by date/duration/title.

**DB-48 · Pagination** — S
The list loads everything. Use `limit`/`offset` (already in `ALLOWED_QUERY`) with infinite scroll; keep live rows pinned.

---

## 6. Recordings

**DB-50 · Audio player** — M
`/recordings` list and a player on the meeting page: `GET /recordings/{id}/master?type=audio` → range-streamed
`.../raw` through a new allowlisted route that forwards `Range` and passes `206`/`Content-Range` back
(`docs/docs/how-to/recordings.mdx` documents the gateway behaviour). Waveform optional.
Done when: seek works in Chrome, Safari, Firefox against the compose stack.

**DB-51 · Click-a-segment-to-seek** — S · depends on DB-50
Clicking a transcript segment seeks the player to its `start`; the current segment highlights while playing.

**DB-52 · Download and delete recording** — S
Buttons wired to `.../download` and `DELETE /recordings/{id}`; gated by plan (see DB-62).

---

## 7. AI notes (the Otter/Read differentiator)

**DB-60 · Post-meeting summary, action items, key points** — L · *core/agent + dashboard*
On meeting completion, run one governed agent routine (`core/agent/control_plane/routines.py`) that writes a
`summary.v1` note (overview, decisions, action items with owners, open questions) attached to the meeting.
Dashboard shows it above the transcript with a regenerate button. Model comes from `/user/models`
(deployment credential by default). Emit token usage as a fact so billing can meter it.
Done when: a completed test meeting shows a summary within 60s; regenerate replaces it; usage fact recorded.

**DB-61 · Chat with this meeting / across meetings** — M · depends on DB-60
Side panel on the meeting page over `POST /agent/chat` scoped to that meeting; "Ask across all my meetings" in the
search page. Streamed responses.

**DB-62 · Auto-title and auto-tag** — S · depends on DB-60
Untitled meetings get a generated title; the wizard's "what's this meeting about" becomes unnecessary.

---

## 8. Plans, subscriptions and enforcement

Assumed catalog (change in one file, `core/identity/.../billing/catalog.py`, and everything reads it):

| Plan | Price | Meetings / month | Minutes / meeting | Concurrent bots | Recordings | AI notes |
|---|---|---|---|---|---|---|
| **Free trial** | 0 | **1** (resets on the 1st, UTC) | 60 | 1 | 7-day retention | 1 summary |
| **Pro** | monthly / yearly | unlimited | 240 | 2 | 1 year | unlimited |
| **Team** | per seat | unlimited | 240 | 5 | unlimited | unlimited + shared |

The user's stated requirement is "1 per month free"; read as *one meeting per calendar month*. Change the meaning
(minutes instead of meetings, rolling 30 days) only on the issue, not in code.

**DB-70 · Plan catalog + entitlement resolver (core/identity)** — M
`billing/catalog.py` (plans → limits) and `resolve_entitlements(user) -> Entitlements` from
`user.data.subscription_tier` / `subscription_status` / period fields (the `PlatformBillingDataPatch` schema that already
exists). Expose `GET /user/entitlements` (scope `bot,tx`) returning limits + current usage + period end. Add to
`routes.v1.json`. Done when: a user with no subscription resolves to Free; one with `active` Pro resolves to Pro;
`past_due` resolves to Pro with a `grace_until`; `canceled` resolves to Free at period end.

**DB-71 · Usage meter (core/meetings)** — M
Count meetings started and minutes transcribed per user per period. Increment at the point of introduction — the
bot-spawn service (`meeting_api/bot_spawn/service.py`) when a bot is actually admitted, and the lifecycle end event for
minutes — never in the client. Persist as rows, not a counter, so a refund can void one.
Done when: sending two bots in one month yields `meetings_used: 2`; a failed join yields 0.

**DB-72 · Quota enforcement at spawn (core/meetings)** — M · depends on DB-70, DB-71
Extend the existing `max_concurrent_bots` pre-check in `bot_spawn/router.py` with the monthly meeting quota and the
per-meeting minute cap (bot auto-leaves at the cap with a transcript note). Applies to manual `POST /bots` **and**
`calendar_sync` auto-join (`bot_spawn/auto_join.py`) — auto-join skips with a recorded reason rather than joining and
charging. Refusal body: `{error: "quota_exceeded", limit, used, resets_at, upgrade_url}`.
Done when: Free user's second bot of the month is refused with that body; Pro user's is admitted.

**DB-73 · Stripe integration (core/identity)** — L · depends on DB-70
`stripe` Python SDK (MIT). In admin-api: `POST /billing/checkout` (Checkout Session for a price id, customer created
on first use, `stripe_customer_id` stored), `POST /billing/portal` (Customer Portal for card/cancel/invoices),
`POST /billing/webhook` (signature-verified; handles `checkout.session.completed`, `customer.subscription.updated|deleted`,
`invoice.payment_failed|paid`; idempotent on event id) writing the existing `PlatformBillingDataPatch` fields.
Route through the gateway with scope `bot,tx`; the webhook is unauthenticated but signature-gated.
Emit a `subscription.changed` fact to flows beside `onboarding.completed`.
Done when: Stripe CLI replay of the four events moves a test user Free → Pro → past_due → Free with correct period
fields; a replayed event is a no-op.

**DB-74 · Billing page in the dashboard** — M · depends on DB-70, DB-73
`/settings/billing`: current plan, usage bars (meetings, minutes) with reset date, plan cards with Upgrade → Checkout,
Manage → Portal, invoices list. Add `user/entitlements`, `billing/checkout`, `billing/portal` to the allowlists.
Done when: e2e upgrades a stubbed user and the page reflects Pro without reload.

**DB-75 · Paywall and upgrade prompts** — S · depends on DB-72, DB-74
Send-bot dialog shows "1 of 1 free meetings used, resets 1 Oct" and swaps the button for Upgrade when
`quota_exceeded`; auto-join skips surface as a banner on Upcoming; recording/AI features gated by entitlement flags
rather than hidden.

**DB-76 · Trial abuse floor** — S
One free meeting per **verified** identity: entitlements resolve to Free only after DB-12's oracle verifies; block
disposable-domain sign-ups with a maintained list (Category-A source); log sign-ups per IP for review. No CAPTCHA
in scope.

**DB-77 · Admin overrides** — S
Admin-api already has `PATCH /admin/users/{id}` with `max_concurrent_bots` and billing data; add `plan_override`
and `quota_bonus` so support can comp a user. Terminal admin panel gets the two fields.

**DB-78 · Dunning and grace** — S · depends on DB-73
`past_due` → 7-day grace with an in-app banner and one email (flows mailbox); after grace, Free limits apply but data
is retained. Retention purge for Free recordings (7 days) runs in meeting-api's sweeps (`meeting_api/sweeps`).

---

## 9. Notifications and integrations

**DB-80 · Email when the transcript is ready** — M
A flows step on meeting completion mailing a summary excerpt + link. User toggle in Settings.

**DB-81 · Webhooks settings UI** — S
`GET/PUT /user/webhook` form, recent deliveries table (`/user/webhook/deliveries`), test-send.

**DB-82 · API keys** — S
Self-serve token list/create/revoke (admin-api token routes the terminal already uses), scoped to the plan
(Free: none; Pro: yes). Shows the MCP snippet from AGENTS.md with the key filled.

**DB-83 · Transcription settings** — S
Language, model, and bot name via `GET/PUT /user/transcription`; default bot name reused by DB-20.

---

## 10. Production readiness

**DB-90 · Public deployment profile** — M
Compose/Helm values for a public host: HTTPS origin, `DASHBOARD_TRUST_PROXY=true` behind the ingress with ingress-level
rate limits (the in-process limiter is single-instance by design), `NEXTAUTH_URL`, secrets from env, Stripe keys, OAuth
redirect URIs documented for both providers. Update `docs/docs/deployment.mdx` and the helm test counts
(`deploy/helm/tests/test_template.sh` — hot file, sequence with anyone else touching it).

**DB-91 · Observability** — M
Server-side error reporting (Sentry SDK is MIT; self-hosted GlitchTip acceptable), request logging with the
`logevent.v1` trace id the gateway threads, uptime probe on `/api/auth/me`, dashboards for sign-ins, bots sent,
quota refusals, checkout conversions.

**DB-92 · Product analytics** — S
Privacy-respecting, cookie-less event tracking (Plausible/Umami-style, MIT/AGPL — **check**: Umami is MIT, Plausible
is AGPL and must not be vendored; use its hosted script only). Events: signup, calendar_connected, bot_sent,
transcript_viewed, upgrade_clicked, checkout_completed.

**DB-93 · Legal and consent** — S
Terms, Privacy, Cookie pages; consent checkbox at sign-up; data-processing statement covering the bot's presence in
meetings (some jurisdictions require announcing recording — the bot already names itself; document it). Links in the
footer and the wizard.

**DB-94 · Security review of the widened surface** — M · after sections 5–8 land
Re-run `/security-review` on the dashboard: every new allowlist entry, the Stripe webhook, the
recordings range proxy, magic-link token handling. CSP unchanged (nonce-based, no `unsafe-inline`). Update
`SECURITY.md` if the threat model changes.

**DB-95 · Performance and mobile** — S
Lists virtualised past 200 rows, transcript virtualised past 2,000 segments, PWA manifest + installable, 375px layouts
checked in e2e.

**DB-96 · Docs move with the product** — S per PR, continuous
Every task above ships a `docs/changelog.d/` fragment and touches the relevant how-to (`send-a-bot.mdx`,
`calendar-sync.mdx`, `recordings.mdx`) plus a new `docs/docs/billing.mdx` for section 8. `architecture.calm.json`
re-sealed whenever a module or data flow is added (DB-30, DB-32, DB-60, DB-71, DB-73).

---

## Suggested order and parallelism

1. **Week 1:** DB-01, DB-02, DB-03, DB-04, DB-05 (foundation; DB-04 and DB-02 can run in parallel with DB-01 landed first).
2. **Weeks 2–3, three lanes in parallel:**
   - *Billing lane (core):* DB-70 → DB-71 → DB-72 → DB-73.
   - *Calendar lane (core + UI):* DB-30 → DB-31 → DB-33 → DB-34, then DB-32.
   - *Product lane (UI):* DB-10, DB-11, DB-20, DB-41, DB-42, DB-48, DB-44.
3. **Weeks 4–5:** DB-74, DB-75, DB-76, DB-78 (billing UI once core lands); DB-50/51/52; DB-60 → DB-61/62; DB-45, DB-47.
4. **Week 6:** DB-80..83, DB-90..96, DB-94 last.

Rules for anyone taking a task: read `AGENTS.md`; quotas and usage are enforced in the core (point of introduction),
the dashboard only presents them; every new proxy path is an allowlist entry with a shape check and a test; new
dependencies are Category A or listed in `license-exceptions.json`; no per-PR edits to `docs/docs/changelog.mdx`.

---

## DB-02a · Four e2e specs fail in sequence but pass alone — S/M

The harness (DB-02, commit `4112c0e9`) runs 14 checks. **10 pass. 4 fail**, and the four are not
a feature being broken:

| Spec | |
|---|---|
| `04-detail` | opens one meeting, requests only `/meetings/<id>` |
| `04-detail` | a foreign id is a 404, not a list scan |
| `05-send-bot` | paste a Meet URL, gateway receives `POST /bots` |
| `06-calendar` | connect an ICS calendar, toggle auto-join |

**They pass when run alone.** `npx playwright test e2e/specs/04-detail.spec.ts` is green, twice
over. So this is order dependence, not a defect in the feature each one covers. Two leads, in
order of promise:

1. **The dashboard server throws `SyntaxError: Unexpected end of JSON input`** during the run,
   visible in Playwright's `[WebServer]` output. Something parses a body that is empty. The
   likeliest site is `src/lib/adminApi.ts`'s `adminRequest`, which special-cases `204` and then
   calls `res.json()` — any other empty-bodied response reaches `JSON.parse("")`. If that is it,
   **it is a product bug, not a harness bug**, and it is the one thing here worth fixing at the
   point of introduction.
2. State leaking between specs despite `resetStub` in `beforeEach`. The run is already
   `workers: 1, fullyParallel: false`, so this would be state the reset does not clear — most
   likely in the dashboard process (a warm module-level cache, the in-process rate limiter in
   `src/lib/rateLimit.ts`) rather than in the stub.

Start by reproducing lead 1 directly: drive `adminRequest` against a 200 with an empty body.
Do not change a spec to make it pass until the cause is known.

Already fixed while finding this, in `4112c0e9`: the stub served requests as floating promises,
so one rejected handler terminated the process under Node 22 and surfaced as eight later specs
failing on a refused connection. Each request now carries its own rejection catch. That repair
took the suite from 6 passing to 10.

---

## Status (updated 2026-10-08)

Work is done by Sonnet agents, one task per agent, verified by a coordinator that re-runs every
claimed test before pushing. **Every agent reads [`AGENT-RULES.md`](AGENT-RULES.md) first.** It holds
the rules for sharing one checkout, the route rule, how to run each suite on this Windows host, and
the known environmental traps.

### Done, verified and pushed (to `origin/claude/dashboard-service-modern-xoiy2c` through DB-80; everything after, to `origin/claude/compassionate-mendel-qjpmv8`, which contains that branch)

| Task | Commit(s) | What the user sees |
|---|---|---|
| DB-01 | `7358d0b6` | Add Bot dialog: paste a link, or connect an ICS calendar |
| DB-02, DB-02a | `4112c0e9`, `4e8a2977` | Browser test harness; fixed the send-bot confirmation erasing itself |
| DB-03 | `6c801b0f` | Compose hot-reload overlay for the dashboard |
| DB-04 | `34cf1e18` | App shell, account menu, mobile drawer, shared UI primitives |
| DB-05 | `b92d8de1` | Meeting page reads one row, not the whole history |
| DB-30 | `0217476d` | Google Calendar OAuth, core only (no button yet, see DB-31) |
| DB-41, DB-42, DB-60 UI | `5da2c948` | Summary panel, stop recording, rename, delete, participants |
| DB-44, DB-48 | `d21f62d4` | Global search (Ctrl+K), paginated meetings list |
| DB-60, DB-60b | `503ff83c`, `43b24d67`, `e26590fb` | A summary is written for every completed meeting, dashboard bots included |
| DB-70 | `688ffcf9`, `9251ee39` | Plan catalog and `GET /user/entitlements` |
| DB-71 | `3a4c4f9a` | Real usage: only meetings the bot actually joined count |
| DB-72 | `1404bf23` | Free plan enforced: 1 meeting per month, 1 concurrent bot, 402 when exhausted |
| DB-73 | `45763c17` | Stripe checkout, portal and webhook handler (ingress pending, see below) |
| DB-74 (read-only), DB-75 | `7e4b3aeb` | Billing page, remaining-allowance line, paywall message |
| DB-80 | `31e3e89f`, `1ca636f8` | "Your meeting is ready" email to the owner, with a dashboard link |
| DB-30a | `86db7793`, `8b20edaa` | Calendar refresh tokens sealed with AES-256-GCM, bound to user + connection |
| DB-72b | `2b6b3846` | Bots leave at the plan's per-meeting minute cap (Free 60, Pro/Team 240) |
| DB-74b | `85cd8d1e` | Upgrade (Stripe Checkout) and Manage subscription (Portal) buttons on `/billing` |
| Core `has_more` | `25361639` | `GET /meetings` forwards `has_more`; the list shows an honest end state |
| DB-31 | `568eae0c` | Connect Google Calendar button, `/calendar/google/callback`, Reconnect, ICS fallback with field hints |
| DB-32 | `0cc927eb` | Microsoft Graph calendar connector, core only (no dashboard button yet) |
| DB-77 | `ffe05203` + route hardening | `plan_override` and per-period `quota_bonus`; Users tab in the terminal admin panel |
| DB-78 | `615d99db` | One dunning email per failed invoice (flows); Free-plan recording purge sweep (off unless `RETENTION_SWEEP_ENABLED`) |
| DB-33, DB-34, MS connect | `faec48ca` | `/upcoming` (by day, join toggle, skip reason, sync now), `/calendar` health page, Connect Microsoft 365 | e2e 77/77 twice.
| DB-76 (core part) | `3e6d9ea6` | Disposable-domain sign-up refused (vendored CC0 list, `SIGNUP_ALLOW_DISPOSABLE` override); sign-ups logged with IP |
| DB-50, DB-51, DB-52 | `644105c8` | `/recordings` (download, delete), meeting audio player, click a line to seek, playing line highlighted. e2e 83/83 twice |
| Wording sweep | `6abbfad7` + follow-up | Ticket ids and history narration removed from source comments added on this branch |
| e2e fix | see log | Search loading spec holds the stub answer instead of racing a 150ms delay |
| Docker-gated suites | none needed | admin-api 326/326 incl. every never-run testcontainer file; bot `npm test` 644 checks incl. `max-active-cap`. Recipe in AGENT-RULES rule 15 |
| DB-76 dashboard follow-ups | `f86e8064`, `b076ea5b` | Readable sign-up refusal on `/login` (fixed copy per code); client IP forwarded to admin-api as `X-Forwarded-For` when `DASHBOARD_TRUST_PROXY` |
| DB-12, DB-76 (rest) | `7d6095ba`, `60885a00`, `abc0b4f5`, `a8dd0798` | Sign-in provenance in `users.data.identity`; explicit `email_verified: false` on Free = 0 meetings, reason `identity_unverified` (legacy/admin-created accounts unchanged, overrides win); production dashboard refuses to start without `VEXA_INTERNAL_API_SECRET` |
| DB-45, DB-43, DB-47 | `32708f96` | Export dialog (.txt/.md/.docx/.srt/.vtt, copy as Markdown, PDF via print); Speakers dialog naming producer speakers (`metadata.speaker_labels`); tags on meetings with a server-side `?tag=` list filter (`metadata.tags`), list sorting; annotate body now checked. e2e 105/105 twice |
| DB-62 | `09cfbb1a` | flows' summary turn also yields a title and 1–3 tags; an untitled meeting gets the title (an invite's own title wins), a tagless one gets the tags, via meeting-api annotate after a re-read; a person's title is never overwritten (one-round-trip race documented). flows 780 passed / 12 skipped |
| DB-40 | `f48b39c0` | Live meeting page streams transcript lines over `/agent/meeting/stream` (resume via `Last-Event-ID`), falls back to the 5s poll when the stream is unavailable, "Jump to live" pill |
| Billing prices + switching | `307a3ee5` | `/billing` cards show each plan's price read from Stripe (`GET /billing/prices`, 5-min cache) and the yearly saving; one subscription per account (checkout 409s while one is live); `POST /billing/change` switches in place — upgrade on the same interval now with nothing charged until renewal, downgrade or monthly↔yearly at period end (subscription schedule), current plan calls a pending switch off; `canceled` resolves to Free at once; an ended older subscription no longer overwrites the live one; Stripe refusals answer 502 with Stripe's reason. admin-api 405, unit 422, billing e2e 19 |
| Billing return, cancel, resume | `4a07164e` | `POST /billing/sync` re-reads the subscription when Checkout returns (`?checkout=success` → "Payment received — you're on Pro monthly"; `?checkout=cancelled` → "you weren't charged"); "Manage subscription" replaced by "Cancel subscription" (end of paid period, confirmation) / "Resume subscription" plus a "Payment method & invoices" portal link; a Stripe customer deleted in Stripe is replaced on checkout; `stripe_refused` 502 shown as Stripe's reason, not "unreachable". admin-api 419, unit 424, billing e2e 22 |
| DB-61 | `c3cc6773` | Chat panel on the meeting page (focus = that row) and "Ask across all my meetings" on /search over `/agent/chat`, streamed, Stop and New conversation; strict body allowlist. **Do not ship before the core authorization fix in decision 4.** Merged e2e 120/120 twice, unit 402 |

### Decisions waiting on the user

1. **Stripe webhook ingress (production).** Locally this works end to end in Stripe test mode
   (2026-10-04): `stripe listen --forward-to localhost:18057/billing/webhook` delivers to admin-api,
   and the billing page no longer depends on it to confirm a purchase (`POST /billing/sync`). Run
   `stripe listen` with **no `--events`** on Windows: PowerShell turns `a,b,c` into a
   space-separated argument and the CLI then forwards nothing. In production nothing public reaches
   `POST /billing/webhook` yet, so renewals, failed payments and period-end cancellations are only
   recorded on the person's next visit to the billing page. Recommended: a reverse-proxy rule
   forwarding exactly `/billing/webhook` to admin-api. **Blocked on the user choosing a production
   host** (VPS + nginx/Caddy, Cloudflare Tunnel, …). See `docs/docs/how-to/billing.mdx`.
2. ~~**Calendar token encryption.**~~ Decided 2026-09-26: AES-256-GCM (`cryptography`), shipped. `admin_api/app/token_cipher.py` is a sound but hand-built
   HMAC-CTR plus encrypt-then-MAC. Either harden it (enforce a minimum key length; bind the user id
   and calendar id as associated data) or replace it with AES-GCM from `cryptography`, which is
   Category A but a new compiled dependency. **Do this before DB-31 ships.** Until DB-31 exists,
   nobody can store a Google token.
3. ~~**DB-46 sharing**~~ — removed from scope 2026-10-08 (user decision).

4. **A core authorization finding on the `/agent/chat` meeting focus** (found while building
   DB-61; reproduced). Fixed in core 2026-10-08 (`be3f6c4d`, agent tests 599 passed, with a test
   that fails on the previous code), pushed. The user decided no upstream report is needed.
   DB-61 ships only with this fix.

### Next, in order (updated 2026-10-04)

Items 1 and 3–7 are done (DB-46 removed from scope 2026-10-08). Next up: 2 (needs the user), then
8. Remaining, in order:

1. ~~Run the docker-gated suites~~ — done 2026-09-29, all green, no defects (see Done table).
2. **Stripe webhook ingress** for production (decision 1 above — needs the user's host). Test-mode
   billing is done and verified locally (checkout, return confirmation, switching, cancel/resume).
   Still for the user in the Stripe dashboard: turn **off** plan switching and cancellation in the
   Customer Portal settings (keep payment method and invoices). Going live needs live-mode keys,
   price ids and a live webhook endpoint.
3. ~~DB-76 dashboard follow-ups~~ — done 2026-09-29.
4. ~~DB-12 identity oracle, then the rest of DB-76~~ — done 2026-09-29. Open point: Microsoft counts as verified (see open questions).
5. ~~**DB-45 export**~~ — done 2026-10-01. ~~DB-46 sharing~~ — removed from scope.
6. ~~**DB-43 speaker rename** and **DB-47 tags**~~ — done 2026-10-01 (annotate carries both; no
   core field needed).
7. ~~**DB-40 live transcript**, **DB-61 chat**, **DB-62 auto-title**~~ — done 2026-10-01 (DB-61 ships with the core fix in decision 4).
8. **DB-10 magic link**, **DB-11 account page**, **DB-20 first-run wizard**, **DB-21 empty/error
   audit**.
9. **DB-81/82/83 settings** (webhooks UI, API keys, transcription settings).
10. **DB-92/93/95**, **DB-90/91**, then **DB-94 security review last** — include the recordings
    raw proxy (`forwardRaw` in `src/app/api/vexa/[...path]/route.ts`) and the terminal admin
    Users route.

Ticket ids that remain on purpose after the sweep: `architecture.calm.json` (sealed; re-seal with
`pnpm seal:arch` if you want them gone), `core/flows/contracts/flows.v1/carriers.json` and its
golden (contract text), and one `TokenCipherError` message string in `token_cipher.py`.

Open questions found while working (answer on the issue before building on them):

- **meeting-api's in-memory store does not mirror `@>` for arrays.** `InMemoryTranscriptStore`'s
  `metadata_matches` (`collector/fakes.py`) compares each filter value with `==`, so
  `{"tags": ["acme"]}` misses a row tagged `["acme", "internal"]`; the Postgres adapter's JSONB
  `@>` matches it. Test-only (production uses the adapter), but any core test of the tag filter
  would pass or fail for the wrong reason. Fix in the fake: recursive containment.
- **The gateway relays every `/agent/*` stream refusal as `200 text/event-stream`**
  (`_forward_stream`, `gateway/app.py`): a 403/422/501 from agent-api arrives as a JSON body in a
  200, an unreachable agent-api as an empty 200. DB-40 and DB-61 both handle it, but the status
  belongs to the producer; fix in the gateway (relay the status like `_forward_stream_verbatim`).
- **Stream `transcript` events omit `end`/`absolute_start_time`** that the stream entry carries;
  a live meeting's SRT/VTT export lacks end times until the next REST read.
- **DB-62: an invite's own title is used before a generated one** (the agent's call beyond the
  spec). Confirm. The generated block's real hit rate on a live model is unmeasured.
- **DB-61 does not reload chat history** after a page reload (`/agent/sessions/{s}/history` is not
  allowlisted) and does not resume a dropped answer.
- **`config-contract` gate is red on the base**: `core/flows/src/config_preflight.py` has drifted
  from `deploy/contracts/config.v1/preflight.py` (both last touched in b92d8de1).
- **Two stream proxies** (`lib/sseProxy.ts` for GET SSE, `lib/eventStreamProxy.ts` for the chat
  POST) were built in parallel; they overlap and could become one.
- **`docs/docs/api/agent.mdx`** lacks the `turn-complete` frame, `context` and `turn_id`.
- **DB-45 PDF is the browser's print dialog**, not a server-rendered file: a Unicode PDF needs an
  embedded font, and no Category-A font licence was available to vendor. The .docx is written by
  `lib/export.ts` itself (stored ZIP, three parts) instead of a `docx` dependency. It opens in
  python-docx with every line, Unicode included; it has NOT been opened in Word, Pages or Google
  Docs (LibreOffice in the Linux container refused every .docx, including python-docx's own).
- **Microsoft sign-ins count as email-verified** (DB-12). Entra multi-tenant `email` claims can be
  set by a tenant admin and are not proof of mailbox control (the "nOAuth" class). Since the
  account key is the email, this is also an account-linking risk that predates DB-12. For DB-94:
  require the `xms_edov` optional claim, or key Microsoft accounts on `tid`+`oid`.
- **Dev email door sign-ups get 0 Free meetings** (`email_verified: false`). Existing accounts are
  never downgraded; only new accounts through that door. Use `plan_override` for a dev account.

- **Upcoming "Don't join"** is wired to `PATCH /meetings/{id} {auto_join}`, not
  `PUT /meetings/{platform}/{native}/intent` as DB-33's text said: `intent` only takes
  `idle|scheduled` and cannot express skip. The dashboard allowlist admits only the one-key
  `{auto_join}` body. Confirm this is the intended control.
- **Dunning grace** is `period_end + 7 days` (DB-70's resolver), not "7 days after the failed
  payment" as DB-78's text reads. Usually the same day; decide which is the rule.
- **Recordings are not plan-gated** (DB-52): plans carry `recording_retention_days` but no
  on/off flag, so every plan gets list, player, download and delete. Add a flag to the catalog if
  a plan should lose them.
- **`quota_bonus`** (DB-77) is stamped to the current period and does not carry over; support
  re-sends it each month. Confirm.
- DB-77's text assumed a terminal user-edit form existed; none did. A new Users tab was built in
  the hidden admin surface (`clients/terminal/src/surfaces/admin.tsx`), unit-tested only.

How the work was run this week (keep doing it): one coordinator, Sonnet sub-agents, at most one
**dashboard lane** agent at a time (it alone runs `npm run test:e2e`, fixed ports) plus one
**core-only** agent. The coordinator re-runs every suite before pushing. Agent preamble lives in
`AGENT-RULES.md` plus the Linux host notes under "Not verified anywhere" below.

### Product changes already live in the code

- One Stripe subscription per account; plan changes go through `POST /billing/change`.
- A `canceled` subscription is Free at once (Stripe sets it only when the subscription has ended);
  cancelling from the billing page keeps the plan until the paid period ends.
- Existing free users drop from 3 concurrent bots to 1.
- Accounts carrying a tier outside the catalog (for example `commitment_25`) resolve to Free.
- Unknown usage refuses a free user's send instead of allowing it.

### What the user must supply before these work live

Stripe **live-mode** secret key, webhook secret and price ids (test mode is configured and working
locally) · Google Cloud OAuth client for calendar plus
`CALENDAR_TOKEN_ENCRYPTION_KEY` · an Azure app for DB-32 · mail settings for DB-10 · real legal
text for DB-93 · `DASHBOARD_NEXT_URL` for email links.

**Model wiring for chat and summaries (verified 2026-10-04).** Chat, the post-meeting summary and the
company setup all run on the claude-code harness (the Claude CLI), which speaks the **Anthropic**
API; the meeting copilot's cards speak the **OpenAI** API. A provider usually serves the two on
different URLs — DeepInfra: `https://api.deepinfra.com/v1/openai` (OpenAI) and
`https://api.deepinfra.com/anthropic` (Anthropic) — while Settings → Models "custom" mode holds ONE
URL and hands it to both, so the CLI fails with "There's an issue with the selected model". Working
setup: in `deploy/compose/.env`, `VEXA_LLM_*` on the OpenAI URL, `ANTHROPIC_BASE_URL` on the
Anthropic URL with `ANTHROPIC_AUTH_TOKEN` = the same provider key, and `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `VEXA_AGENT_MODEL` all set to the provider's model
id (today `Qwen/Qwen3.5-9B`); Settings → Models on **subscription** (deployment credentials), not
custom. Recreate `runtime` and `agent-api` after changing them, and stop any running
`vexa-worker-*` container (it keeps the env it was spawned with).

To run it locally, rebuild `dashboard-next`, `gateway`, `admin-api`, `meeting-api` and `flows-worker`
— **and the bot image** (`make bot`, or its two `docker build` steps): `meeting-api` and the bot
share the `invocation.v1` contract, which rejects unknown fields, so a bot older than `meeting-api`
exits at start with `FATAL invocation.v1 … must NOT have additional properties` and never joins.
In production, build and deploy every image, the bot included, from one commit under one
`IMAGE_TAG`, and pull the bot image before switching the services.

### Not verified anywhere

- Docker-gated suites: run 2026-09-29 on the Windows docker host, all green (admin-api 367 after
  DB-12; bot 644 checks). Recipe in AGENT-RULES rule 15.
- e2e ports shift with `E2E_PORT_OFFSET=<n>` (`e2e/ports.mjs`), so two checkouts can run
  `test:e2e` at once; without it, two runs in one container collide.
- Never run a workspace-wide `pnpm install`/`turbo` on that host: it moves npm-installed
  `clients/dashboard` and `clients/terminal` node_modules into `.ignored/`. Recover with `npm ci`
  inside each client.
- The terminal admin Users tab (DB-77) has unit coverage only; no browser test.

- Stripe: test-mode live leg done 2026-10-04 — checkout, `/billing/sync` on return, webhook via the
  Stripe CLI; schedule and cancel calls proven against the test API with throwaway customers. Not
  witnessed in the browser yet: a plan switch and cancel/resume on a real subscription, and a
  scheduled switch actually taking effect at period end. Nothing against live mode.
- No live leg against Google. Calendar is mocked or stubbed.
- **Summaries and every flows email wait on the instance gate** (`[loop] PARKED by the instance gate`
  in the flows-worker log) until admin-api's `global_setup` platform setting reads
  `state: completed`. The code names agent-api's `POST /api/global/ready` as its only writer, but no
  such route exists in this tree — a fresh install never opens the gate on its own. Report upstream;
  until then it is opened by hand through admin-api's internal settings route.
- `admin-api/tests/test_onboarding_event.py`'s second-create case failed once in a slow full run
  (2026-10-04) and passes alone; watch for it.
- Gateway `test_edge_guard.py::TestBothLayers::test_valid_key_429_from_rate_limiter_and_keyless_429_from_guard`
  fails on the base too (a stray `retry-after` header); not caused by this branch.
- `admin-api/tests/test_stack_admin_api.py` and `test_stack_redis.py` hang on this host.
- These gates are red here for environmental reasons that predate this work: `node`, `graph`,
  `schema`, `config-contract` (no root `node_modules`, and `npx` cannot be spawned on Windows),
  `compose` (no `uv`), and `contract-version` (`core.autocrlf=true` changes every hash).
