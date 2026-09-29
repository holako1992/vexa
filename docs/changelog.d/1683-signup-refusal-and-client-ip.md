- **Dashboard: a refused sign-up says why, and admin-api sees the user's address (DB-76, #1683).**
  A sign-up refused for a disposable/throwaway email domain now shows a readable message on `/login`
  on both the Google/Microsoft door and the development email door, instead of a bare failure or
  raw JSON; any other refusal shows a generic message, and the page only ever displays fixed copy
  for a known code. The dashboard also forwards the signing-up user's address to admin-api as
  `X-Forwarded-For` on account creation, so the sign-up log records the person rather than the
  dashboard server. The address is taken exactly as the login rate limiter takes it: only when
  `DASHBOARD_TRUST_PROXY=true`, and never from a client-supplied header otherwise.
