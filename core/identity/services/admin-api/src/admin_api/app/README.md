# app — the admin-api FastAPI surface

`main.py` exposes `create_app()` with 3 auth tiers (admin `X-Admin-API-Key`, user `X-API-Key`,
internal `X-Internal-Secret`) and the gateway's fail-closed `/internal/validate` oracle. `db.py`
builds an INJECTABLE async engine so the same app runs against testcontainers-PG or prod.
`calendars.py` is the calendar-connection value object (ICS and, since DB-30/DB-32, Google and
Microsoft Graph OAuth connections) stored inside a user's `data` JSONB — masking, the internal
secret-gated read, and the `reconnect_needed` flag setter. `google_oauth.py` / `microsoft_oauth.py`
are each provider's OAuth mechanics: the signed CSRF state, the consent-URL builder, and the
token/userinfo HTTP calls (same shape, domain-separated by their own state label). `token_cipher.py`
is the AES-256-GCM construction the Google and Microsoft refresh tokens are both stored under —
never in the clear.

_Governed by `docs/docs/governance/architecture.mdx` (P1–P12). This folder owns one concern; its public surface is its `index`/contract; it may depend only on what the dependency-rules allow._
