# `src/app/settings/` — settings pages

- `account/` — `/settings/account`: profile, sign-in method, active sessions, sign out everywhere.
- `transcription/` — `/settings/transcription`: the default bot name and the transcription
  service (this Vexa's, or the person's own endpoint and write-only token).

Each page is a server component that resolves the signed-in user, redirects to `/login` when there
is none, and composes its view inside `Shell`, like every other route in `src/app/`.
