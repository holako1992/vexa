# `src/app/api/auth/login/` — the email sign-in door

Password-less, and therefore **development only**: it proves no ownership of the address. It is
closed unless `DASHBOARD_ALLOW_EMAIL_LOGIN=true`, and even then only opens for addresses matching
`DASHBOARD_EMAIL_LOGIN_PATTERN` (default: contains `test`).

Guards run in order — same-origin write · rate limit (5 per 10 minutes per caller) · feature flag ·
format · allowed address — so a disabled deployment refuses before it ever reaches admin-api.
