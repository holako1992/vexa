# `src/app/login/` — the sign-in page

A server component whose only job is to decide which sign-in methods this deployment has
(`googleEnabled()`, `microsoftEnabled()`, `DASHBOARD_ALLOW_EMAIL_LOGIN`) and pass three booleans to
`components/LoginForm`. Client ids and secrets stay on the server.
