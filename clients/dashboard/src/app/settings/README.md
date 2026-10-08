# `src/app/settings/` — settings pages

- `account/` — `/settings/account`: profile, sign-in method, active sessions, sign out everywhere.

Each page is a server component that resolves the signed-in user, redirects to `/login` when there
is none, and composes its view inside `Shell`, like every other route in `src/app/`.
