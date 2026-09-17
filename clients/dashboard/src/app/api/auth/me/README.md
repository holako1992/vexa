# `src/app/api/auth/me/` — who-am-I

Returns the identity **verified** against admin-api's internal oracle where the deployment
configures one, and flags `verified: false` where it does not. The `vexa-user-info` cookie is a
display name and never an authority: `httpOnly` stops a script from reading it, not a hand-crafted
`Cookie` header from setting it.
