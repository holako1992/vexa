# `src/app/api/auth/` — sign-in, sign-out, who-am-I

- `authOptions.ts` — the NextAuth configuration. It lives beside the route rather than in it
  because an App Router route file may only export HTTP handlers. Its `signIn` callback is the
  load-bearing step: a verified OAuth identity becomes the `vexa-token` + `vexa-user-info` cookies
  through the same find-or-create+mint path the email login uses.
- `[...nextauth]/` — the NextAuth handler.
- `login/` — the **development** email door. Closed unless `DASHBOARD_ALLOW_EMAIL_LOGIN=true`, and
  then only for addresses matching `DASHBOARD_EMAIL_LOGIN_PATTERN`. Same-origin, rate limited.
- `logout/` — POST, same-origin. Clears both cookies.
- `me/` — the verified identity where the oracle is configured, flagged `verified: false` where it
  is not.
