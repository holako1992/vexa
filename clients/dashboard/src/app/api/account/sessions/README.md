# `src/app/api/account/sessions/` — sign out everywhere

`DELETE` only. Same-origin write, then the identity oracle, then a 5-per-10-minutes limit per
account. It revokes every `dashboard-login` token of the caller at admin-api (tokens the person
made for themselves, and the terminal's, are left alone) and clears this browser's cookies through
`lib/session.ts`. If any revoke fails it answers 502 and clears nothing: a partial sign-out is not
reported as complete. The request body and query are ignored.
