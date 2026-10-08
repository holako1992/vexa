# `src/app/api/account/` — the account page's server routes

- `route.ts` — `GET /api/account`: name, email, the recorded sign-in door and the `dashboard-login`
  sessions, for the user the identity oracle names for the session cookie.
- `sessions/` — `DELETE /api/account/sessions`: sign out everywhere.

These live in the dashboard (same-origin, session-authenticated) rather than behind the gateway
because admin-api's token routes are admin-key routes: the key stays on this server, and the user
id is taken from `lib/accountApi.ts`'s `resolveAccountCaller()` only. No handler reads a user id,
email or token id from the request. Where the identity oracle is not configured the routes answer
503 instead of trusting the display-only cookie.
