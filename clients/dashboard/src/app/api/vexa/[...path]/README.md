# `src/app/api/vexa/[...path]/` — the proxy handler

Matches the allowlist, attaches the signed-in user's key from the httpOnly cookie, forwards, and
passes the upstream status through with a JSON body. No upstream header is copied back — a backend
must not be able to set a header on this origin.

**There is no environment-key fallback.** The terminal falls back to `VEXA_API_KEY` for single-key
self-hosts; this must not, because it is a multi-user surface — a fallback would serve one
deployment-wide identity's meetings to whoever was at the keyboard. No cookie means 401.
