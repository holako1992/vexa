# `clients/dashboard/e2e/` — the browser test harness (DB-02)

Everything else in this package tests against a mocked `fetch`. This directory is what turns
"the unit tests pass" into "the product works": Playwright drives a real Chromium against a
REAL running `next dev` dashboard, which talks to a REAL running stub of the two upstreams it has
(the gateway and admin-api) — nothing here is mocked at the `fetch` layer.

- `ports.mjs` — the three fixed ports (stub gateway, stub admin-api, dashboard) and the shared
  test secrets (admin key, internal-oracle secret, email-login pattern), in one place so the
  stub process, `playwright.config.ts`, and every spec agree without importing each other's
  runtime code — the stub runs as a separate OS process, so it can only share plain data, not
  live references.
- `fixtures.mjs` — the canned world: six meetings spanning live/scheduled/past (including one
  user-stopped `completed` row for the derived "stopped" status, one completed row with no
  `summary.md` yet, and one with a `status: skipped` note), a five-line, two-speaker transcript
  with offsets, a `summary.v1` note per meeting id (`summaryFor`, DB-60), and an invite/speaker
  roster for the live meeting (`participantsFor`, DB-42). `freshMeetings()` / `freshCalendars()`
  return deep clones so the stub's mutations during one spec never leak into the next.
- `stub-server.mjs` — the stub backend itself: plain `node:http`, no dependency, because the
  fixtures are the point, not a framework. Runs two listeners in one process (the gateway and
  admin-api) plus a `/__control/*` remote control the specs use to reset state, inspect exactly
  which upstream requests were made (with which headers), and force a path to fail. Also answers
  `GET /agent/workspace/file?path=meetings/<id>/summary.md` (DB-60), `GET /bots/status` and
  `DELETE /bots/<platform>/<native>` (DB-41), and `GET
  /meetings/<platform>/<native>/participants`, `POST /meetings/<id>/annotate`, `DELETE
  /meetings/<id>` (DB-42). See the file's own header comment for the full route table.
- `playwright.config.ts` — boots BOTH servers via Playwright's `webServer` (the stub, then
  `next dev` pointed at it with the matching env vars) so `npm run test:e2e` runs everything from
  a cold start with no manual setup. Calls `next dev` directly with a literal `--port` rather than
  `npm run dev` (`next dev --port ${PORT:-3001}`) because npm always runs package scripts through
  `cmd.exe` on Windows regardless of the invoking shell, and that bash-style `${VAR:-default}`
  never expands there.
- `specs/` — the thirteen specs. See `specs/README.md`.

## Running it

```bash
cd clients/dashboard
npx playwright install chromium   # once per machine; ~150MB download
npm run test:e2e
```

`npm test` (vitest, the fast unit loop) does **not** depend on this — it has no browser
dependency and must keep passing with zero setup. This is the slower, real-browser loop layered
on top of it (AGENTS.md's "the two loops").

## A `next dev`-only wrinkle, found while writing spec 08

`specs/08-key-safety.spec.ts` set out to scan every page's HTML for the raw session token, and
found it: Next 15's React Server Components debug payload embeds the literal value of every
cookie a Server Component reads via `cookies()` (`src/lib/session.ts`'s `sessionToken()` /
`currentUser()`, called from `page.tsx` and `meetings/[meetingId]/page.tsx`) as a string inside
the page's flight data — but **only under `next dev`**. Verified with `npm run build && npx next
start`: the same request, same cookie, same page, no token in the body. Neither this app's code
nor its middleware puts it there; it's Next's own dev-time instrumentation. The spec now scans
only the JSON surfaces a script could actually fetch (`/api/vexa/meetings`, `/api/auth/me`) —
scanning dev-only HTML would be testing Next's tooling, not this app — and this paragraph is the
finding, not swept under the spec.

## Why a hand-rolled stub instead of a mocking library

The allowlist (`src/lib/upstream.ts`) and the write surface (`resolveWriteUpstream`) are a closed,
tested table already — what has NEVER been exercised is whether a real HTTP round trip through
`next dev`'s own server, middleware, and route handlers produces the request the allowlist says it
should, with the session cookie's key attached and nothing else leaking. A mocked `fetch` cannot
show that; only a second real server can. Zero new dependencies also means `gate:licenses`
(ADR-0004) has nothing new to classify for this harness itself — `@playwright/test` (Apache-2.0)
is the one added dependency, pinned at `1.56.0` to match the other three Playwright consumers in
this monorepo (`core/meetings/modules/{join,recording,remote-browser}`).
