# `src/app/api/` — the server handlers

Three groups, and nothing else is reachable:

- **`auth/`** — the session: OAuth (NextAuth), the development email door, sign-out, and who-am-I.
  All of them end at the same two cookies, written by the single writer in `lib/session.ts`.
- **`account/`** — the account page's two routes: read the profile and sessions, sign out
  everywhere. Same-origin and session-authenticated; the user is always the oracle's answer for the
  cookie.
- **`vexa/[...path]/`** — the ONE door to the backend. A closed allowlist, GET only, forwarding the
  signed-in user's own key.

No handler here accepts a backend host, a path or a key from the client.
