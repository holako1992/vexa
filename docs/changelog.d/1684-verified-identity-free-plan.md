- **The Free meeting is for verified identities (DB-12, DB-76, #1684).** Sign-in now records how an
  account proved its email address (`data.identity`: provider, `email_verified`, `verified_at`),
  sent by the dashboard on `POST /admin/users` and, for a returning verified sign-in, on
  `PATCH /admin/users/{id}` (`identity_provider` + `email_verified`). A Free account whose record
  says `email_verified: false` — in practice one created through the development email door — gets
  0 included meetings, with `reason: "identity_unverified"` on `GET /user/entitlements`, in the
  spawn-time `quota` block, and in the `402 quota_exceeded` body; the dashboard explains it in fixed
  words on `/billing` and in the Send Bot dialog. Accounts with no record (existing accounts,
  terminal- and API-created users) are unchanged, and paid plans and `plan_override` still win.
  Google's `email_verified` claim is honoured; a Microsoft sign-in counts as verified. The dashboard
  service in `deploy/compose` now requires `INTERNAL_API_SECRET`, so `/api/auth/me` never reports
  `verified: false` in a composed deployment.
