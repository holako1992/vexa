# `src/lib/` — the seams

- **`session.ts`** — the ONE place a request's identity is established and the only writer of the
  session cookies. Two tiers, kept distinct: `sessionToken()` is the credential sent upstream;
  `currentUser()` is the identity, verified against admin-api's oracle where configured.
- **`adminApi.ts`** — server-only admin-api client: find-or-create by email, mint the login token,
  cap the login tokens, validate a token. It mirrors the terminal's slice rather than importing it
  — the two clients are separate npm projects, and a client must not depend on another client at
  runtime.
- **`upstream.ts`** — the closed allowlist that defines the entire backend surface. Pure, so the
  table is tested directly.
- **`security.ts`** — the CSP, the header set, the cookie-security decision, the same-origin write
  guard, and `safeNext()` (the open-redirect guard on the post-login target).
- **`rateLimit.ts`** — a fixed-window limiter for the credential endpoints. Per-process and
  in-memory; it bounds one instance and says so.
- **`meetings.ts`** — the shapes the UI renders and the mapping onto them. Presentation only: it
  picks a title, buckets a status, formats a time. It never reshapes a transcript.
- **`api.ts`** — the browser fetch helper. Fails loud, so a failure never degrades into an empty
  list.
