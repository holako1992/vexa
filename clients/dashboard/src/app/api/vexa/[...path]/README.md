# `src/app/api/vexa/[...path]/` — the proxy handler

Matches the allowlist, attaches the signed-in user's key from the httpOnly cookie, forwards, and
passes the upstream status through with a JSON body. No upstream header is copied back — a backend
must not be able to set a header on this origin.

**There is no environment-key fallback.** The terminal falls back to `VEXA_API_KEY` for single-key
self-hosts; this must not, because it is a multi-user surface — a fallback would serve one
deployment-wide identity's meetings to whoever was at the keyboard. No cookie means 401.

**A resolved path may carry its own fixed `?query`** — `meetings/<id>/summary` (DB-60) resolves to
`/agent/workspace/file?path=meetings/<id>/summary.md`, composed server-side from the numeric id
alone. The GET handler detects that (`route.path.includes("?")`) and drops the incoming request's
entire query string in that case, rather than appending `filterQuery()`'s result — so a caller's
own `?path=...` can never reach the upstream call, merged or otherwise.

**Otherwise, `filterQuery(route, req.nextUrl.searchParams)` filters against the RESOLVED route's
own declared query shape** (`upstream.ts`'s `UpstreamRoute.query`), not a set of names shared by
every route this handler resolves — see `upstream.ts`'s header comment on `filterQuery` for why
that distinction exists (DB-44's `transcripts/search` needed a free-text `q` param, and a global
allowlist would have forwarded it to every other GET route too).

**An `sse: true` route streams** (DB-40's `meetings/<id>/stream`, the live transcript):
`lib/sseProxy.ts`'s `forwardSse` pumps the gateway's `text/event-stream` body through chunk by
chunk, never buffering it, opens with an SSE comment so the browser receives the response head
at once, forwards the caller's `Last-Event-ID` only when it is the producer's cursor shape, and
aborts the upstream request when the browser goes away.

**`PUT` is a write method** (`/user/calendar` for the default bot name, `/user/first-run` for the
welcome's position), resolved by the same `resolveWriteUpstream` and checked against the same
per-route body shapes as POST/PATCH/DELETE.
