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
entire query string in that case, rather than appending the paging allowlist's `filterQuery()`
result — so a caller's own `?path=...` can never reach the upstream call, merged or otherwise.
