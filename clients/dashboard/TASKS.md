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

**DB-46 · Sharing** — M
Share dialog: generate a link (`POST /meetings/{id}/share`), list/revoke shares, and a public read-only
`/s/<token>` page that accepts via `POST /transcripts/share/accept` without a dashboard account. Shared-with-me tab
(the row already carries `shared`). Done when an incognito browser reads a shared transcript and nothing else.

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
Re-run `/security-review` on the dashboard: every new allowlist entry, the share page, the Stripe webhook, the
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
3. **Weeks 4–5:** DB-74, DB-75, DB-76, DB-78 (billing UI once core lands); DB-50/51/52; DB-60 → DB-61/62; DB-45, DB-46, DB-47.
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
