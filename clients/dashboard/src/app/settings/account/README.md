# `src/app/settings/account/` — the account page

`page.tsx` resolves the signed-in user (redirecting to `/login` when there is none) and renders
`components/AccountView.tsx` inside `Shell`. The view shows the person's name, email (read-only),
avatar initials, the sign-in door admin-api recorded, and their dashboard sessions, and offers
**Sign out everywhere** behind a confirmation. It reads `GET /api/account` and writes
`DELETE /api/account/sessions`; both are in `src/app/api/account/`.

There is no delete-account control here: erasing an account across the core's services is not
something the core can do yet, and a control that removed only part of the data is not shipped.
