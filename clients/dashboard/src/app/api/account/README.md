# `src/app/api/account/` — the account page's server routes

- `route.ts` — `GET /api/account`: name, email, the recorded sign-in door and the `dashboard-login`
  sessions, for the user the identity oracle names for the session cookie. `DELETE /api/account`
  `{confirmEmail}`: erase the account now. Same-origin, oracle caller, 3 tries per 10 minutes, the
  typed email must equal the oracle's (400 before any admin call), then admin-api
  `DELETE /admin/users/{id}` with up to 3 attempts for a partial. 200 and 404 clear the cookies and
  succeed; a 409 answers a fixed sentence; a still-partial answer (502) clears the cookies too, the
  core having revoked the tokens, and says so plainly. Producer text is never relayed.
- `sessions/` — `DELETE /api/account/sessions`: sign out everywhere.

These live in the dashboard (same-origin, session-authenticated) rather than behind the gateway
because admin-api's token routes are admin-key routes: the key stays on this server, and the user
id is taken from `lib/accountApi.ts`'s `resolveAccountCaller()` only. No handler reads a user id,
email or token id from the request. Where the identity oracle is not configured the routes answer
503 instead of trusting the display-only cookie.
