- **Sign-up trial-abuse floor: disposable-domain block + per-IP signup logging (DB-76, #1681).**
  `POST /admin/users` — the one place any sign-in path creates an account — now refuses a
  disposable/throwaway email domain with a typed `422 {error: "disposable_email_domain"}`,
  matching registrable domains and their subdomains, case-insensitive, against a vendored CC0
  list (`admin_api/data/disposable_email_domains.txt`, ADR-0004 Category A). An address that
  already has an account is never affected. Two live-read env overrides:
  `SIGNUP_ALLOW_DISPOSABLE=true` (disable the block) and `SIGNUP_DISPOSABLE_EXTRA_DOMAINS`
  (operator-added domains, no redeploy). Every signup also logs the domain and whatever client
  address the request carries, for review — never to block. See
  [Sign-up: the trial-abuse floor](/how-to/billing#sign-up-the-trial-abuse-floor), including the
  honest note that admin-api sees the dashboard server's own address today, not the signing-up
  browser's, until the dashboard forwards one, and the DB-12 gap this surfaced: core stores no
  verified-identity flag yet, so the Free allowance is not (and could not honestly be) narrowed
  to verified identities in this change.
