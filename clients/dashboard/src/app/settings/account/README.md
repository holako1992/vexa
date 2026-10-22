# `src/app/settings/account/` — the account page

`page.tsx` resolves the signed-in user (redirecting to `/login` when there is none) and renders
`components/AccountView.tsx` inside `Shell`. The view shows the person's name, email (read-only),
avatar initials, the sign-in door admin-api recorded, and their dashboard sessions, and offers
**Sign out everywhere** behind a confirmation. It reads `GET /api/account` and writes
`DELETE /api/account/sessions`; both are in `src/app/api/account/`.

**Delete account** erases the account immediately and for good, behind a dialog that asks for the
account's email address: `DELETE /api/account {confirmEmail}`, which admin-api's
`DELETE /admin/users/{id}` carries out across meetings, agent and flows. Success is a hard
navigation to `/login` with the account-deleted notice. A deletion that only partly finished says so
and signs the person out (repeating it finishes the rest); the last admin is refused (`409`) until
another account is made admin.
