# bot_spawn — `POST /bots`

The bot-spawn flow, ported from the parent `meetings.request_bot` CORE happy path. Builds the bot's
invocation, mints the MeetingToken, spawns the meeting-bot workload over the runtime kernel, and
eager-creates the `MeetingSession` keyed by the bot's `connectionId`.

## Front door
- `build_router(repo, runtime)` — the mountable `POST /bots` router (the unified
  `meeting_api.app.create_app` mounts it).
- `request_bot(...)` — the spawn flow (the router's core; callable directly in tests).
- `build_invocation(...)` / `build_workload_spec(...)` / `mint_meeting_token(...)` — the
  `invocation.v1` / `runtime.v1` builders + the stateless MeetingToken minter. Both builders
  validate against the sealed schema **at the seam** before anything ships.
- `MeetingRepo` / `RuntimeClient` ports + `QuotaExceeded` / `MaxBotsExceeded` /
  `MeetingQuotaExceeded` / `SpawnFailed` / `DuplicateMeeting`.
- `adapters.build_production_router(...)` — wire with real SQLAlchemy + the httpx runtime client.
- `fakes` — `InMemoryMeetingRepo` / `FakeRuntimeClient` (offline drivers).

## The flow (P2 core + P3 control-plane)
construct the meeting URL → dedup (409 on a CONCURRENT active prior) → **max-bots pre-check (429)**
→ mint a per-run service identity → **optional service-authority admission before any row/runtime
effect (403 deny, 503 unavailable)**
→ **continue_meeting (reuse a TERMINAL prior row)** or insert a fresh `Meeting` row (status
`requested`) → mint the MeetingToken + build the `invocation.v1` invocation → spawn the `runtime.v1`
`WorkloadSpec` (`profile="meeting-bot"`; the invocation rides as the one `BOT_CONFIG` env var) →
eager-create the `MeetingSession` (`session_uid` == `connectionId`) → write the kernel workload id
back as `bot_container_id` → return the `api.v1` `MeetingResponse` (now listing its `sessions`).

### P3c — `continue_meeting` (sequential multi-bot per meeting)
When the prior meeting for `(platform, native_id)` is TERMINAL (`completed`/`failed`), reuse the
SAME meeting row + add a NEW `MeetingSession` instead of the 409. Transcripts + recordings stay keyed
by the (unchanged) meeting row, so a continued run preserves them. A CONCURRENT second bot (prior
still active) is still rejected (409).

> **Contract decision (api.v1 is SEALED — DO NOT edit it).** The `POST /bots` request body
> (`MeetingCreate`) has **no `additionalProperties: false`** — it is an OPEN object — so an extra
> `continue_meeting` field on the wire is NOT rejected by the frozen schema, and the behaviour ships
> now via an internal request param. **FLAG (lane:contract):** the schema does not *declare*
> `continue_meeting`; exposing it as a documented, typed PUBLIC field on `api.v1` needs a `vN+1`
> (a human-reviewed `lane:contract` change). Same for the response: the listed `sessions[]` ride in
> the open `data.sessions` (MeetingResponse `data` is `additionalProperties:true`), not a new typed
> field — a typed `sessions` field is likewise a `vN+1`. `gate:contract-version` stays green (no
> sealed schema touched).

### P3e — max-bots (per-user concurrency)
A pre-check BEFORE the runtime call: count the user's ACTIVE bots (status in
`{requested, joining, awaiting_admission, active}`, **excluding** infra `browser_session` —
parent `meetings.py:1091`) and reject the N+1th with `429` (`MaxBotsExceeded`). The cap arrives as
the gateway's `X-User-Limits` header (resolved upstream from `/internal/validate`, identity.v1).
The runtime kernel's own `owner_quota` → `QuotaExceeded` (→ 429) is the defense-in-depth BACKSTOP.
Join-retry re-spawns and `continue_meeting` sessions count against the same cap.

Tests: `../../../tests/test_bot_spawn.py` · `test_continue_meeting.py` · `test_max_bots.py`.
Join-retry (P3d) lives in the `lifecycle` brick: `lifecycle/retry.py` + `test_join_retry.py`.

### DB-72 — the MONTHLY meeting quota (a DIFFERENT axis from max-bots)

max-bots (above) caps how many bots are running RIGHT NOW; DB-72 caps how many meetings a user may
START in a calendar period (Free: 1/month; Pro/Team: unlimited). Both run in `request_bot`, BEFORE
any DB write, off the SAME best-effort `_fetch_bot_context(user_id)` call the transcription/
capture/bot-name resolution already makes (`admin-api`'s `/internal/users/{id}/bot-context`) — no
second network call added for the quota check.

- **The check.** `bot_context["quota"]` is present ONLY when the caller's resolved plan has a
  FINITE `meetings_per_month` (an unlimited plan's bot-context omits the key entirely, so
  Pro/Team spawns are never checked on this axis). When present:
  `meetings_used is None or meetings_used >= meetings_per_month` raises `MeetingQuotaExceeded`.
  `meetings_used is None` means admin-api's own usage query FAILED — a FINITE plan with UNKNOWN
  usage fails CLOSED (refused), never silently admitted as "0 used".
- **"Which meetings count" lives in ONE place**, admin-api's `billing/meetings_usage.py` (a bot
  that never reached the room never consumes the quota) — this package does not restate that
  rule; it trusts whatever `meetings_used` the door reports.
- **Manual `POST /bots`** answers `402 Payment Required` with an UNWRAPPED body (not
  HTTPException's `{"detail": ...}` envelope, so the dashboard can read `error` directly):
  `{"error": "quota_exceeded", "limit": N, "used": N|null, "resets_at": "<ISO>", "upgrade_url":
  "<url>"|null}`. 402 over 429/403: the request is well-formed and the caller is who they say
  they are, and it is not a burst the caller can just retry — the billing period's allowance is
  spent.
- **Auto-join** (`auto_join.py`) SKIPS the due row on the same exception — it never joins and
  never charges a meeting the quota already refused — stamping `data.auto_join_error` with the
  reason (+ the standard retry backoff), the same recorded-reason path every other auto-join
  refusal (cap, spawn failure) already uses.
- **The concurrent-bot cap ITSELF is also billing-shaped now (DB-72, not a new axis but a changed
  number):** `/internal/validate`'s `max_concurrent` (→ `X-User-Limits`) and bot-context's own
  `max_concurrent` are both the resolved plan's `concurrent_bots` combined with the pre-billing
  `users.max_concurrent_bots` column (`admin-api`'s `billing.catalog.effective_concurrent_cap`) —
  see `core/identity/services/admin-api/src/admin_api/app/billing/README.md` for the combination
  rule and the stated product change for existing Free users.
- **The per-meeting minute cap is NOT enforced by this change.** The bot module
  (`core/meetings/services/bot/src/index.ts`) has exactly one duration ceiling,
  `deriveMaxActiveMs` — a DEPLOYMENT-WIDE `BOT_MAX_ACTIVE_MS` env var (default 4h), never a
  per-invocation/per-plan value. `_resolve_automatic_leave` in `router.py` accepts a caller-sent
  `max_bot_time` key (so it does not 422) but never translates it into anything the invocation or
  the bot reads — it is silently dropped. Wiring a per-plan minute cap through to the bot is new
  bot-runtime work, out of scope for this task; it is not built here.

Tests: `../../../tests/test_monthly_quota.py`.

### Optional external service authority

`VEXA_SERVICE_AUTHORITY_CONFIG` enables the sealed, policy-free
`service-authority.v1` seam. The request contains authoritative user/service identity, service
mode, frozen transcription provider, concurrency, and lifecycle timing—never an email, payment
provider ID, price, balance, transcription URL, or credential. The exact JSON bytes are signed
with `VEXA_SERVICE_AUTHORITY_SECRET`.

The admitted decision is frozen in `meeting.data.service_authority`. A meeting-api-owned sweep
asks again at every admitted-time + N-minute boundary. An enforced stop is persisted before the
runtime teardown and converges after restart; repeated sweeps never apply the same decision twice.
Observe-only sessions are never later reinterpreted as enforced sessions.

No config means explicit stock OSS allow-all. Once configured, unavailable, malformed, stale, or
cross-bound decisions fail closed. `mode=observe` records the authority response but cannot satisfy
a hosted hard-spend-cap claim.
