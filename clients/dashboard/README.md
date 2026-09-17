# Vexa Dashboard

A simple, modern web client for **meetings and transcripts**, running alongside the
[Terminal](../terminal/README.md) on its own port. The Terminal is an IDE-shaped workbench; this
is the read surface — a list of your meetings, and the transcript of any one of them.

| | Terminal | Dashboard |
|---|---|---|
| Shape | workbench (tabs, chat, canvas, agent) | list + detail |
| Dev port | 3000 | **3001** |
| Compose host port | 13000 | **13002** |
| Backend surface | the gateway's meetings **and** agent domains | three read paths (below) |
| Live updates | websocket proxy (`/ws`) | polling |

Both hold the same session contract — the httpOnly `vexa-token` + `vexa-user-info` cookies — so a
deployment fronting both behind one domain is one sign-in.

## Run it

```bash
npm install
npm run dev            # http://localhost:3001
```

It needs a Vexa core to talk to. Against the compose stack:

```bash
GATEWAY_URL=http://localhost:18056 \
VEXA_ADMIN_API_URL=http://localhost:18057 \
VEXA_ADMIN_API_KEY=$ADMIN_TOKEN \
DASHBOARD_ALLOW_EMAIL_LOGIN=true \
npm run dev
```

In the compose stack itself it is a profile, off by default:

```bash
docker compose --profile dashboard-next up -d    # http://localhost:13002
```

## Configuration

| Variable | Meaning |
|---|---|
| `GATEWAY_URL` | The gateway the proxy forwards to. Default `http://127.0.0.1:18056`. |
| `VEXA_ADMIN_API_URL` / `VEXA_ADMIN_API_KEY` | admin-api, for find-or-create + token mint at sign-in. Without them, sign-in returns 503 and says so. |
| `VEXA_INTERNAL_API_SECRET` | Enables the identity oracle (`/internal/validate`). Set → the signed-in identity is *verified*; unset → it degrades to "a session token is present" and `/api/auth/me` reports `verified: false`. |
| `NEXTAUTH_SECRET` | Required for the OAuth flow. |
| `NEXTAUTH_URL` / `DASHBOARD_URL` | The public origin. An `https://` value flips the session cookies to `Secure` and turns on HSTS. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enables the Google button. Redirect URI: `${NEXTAUTH_URL}/api/auth/callback/google`. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | Enables the Microsoft button. Redirect URI: `${NEXTAUTH_URL}/api/auth/callback/microsoft`. |
| `DASHBOARD_ALLOW_EMAIL_LOGIN` | `true` opens the password-less email door. **Development only** — it proves no ownership of the address. |
| `DASHBOARD_EMAIL_LOGIN_PATTERN` | Regex an address must match for that door. Default: contains `test`. |
| `DASHBOARD_TRUST_PROXY` | `true` when behind a reverse proxy, so rate limiting reads `X-Forwarded-For`. Off by default — that header is client-settable. |
| `VEXA_DASHBOARD_LOGIN_TOKEN_CAP` | How many `dashboard-login` tokens one user keeps. Default 3. |

## Security posture

Stated plainly, because "it has auth" is not a description.

- **Nothing renders without a session.** `src/middleware.ts` gates every path but `/login`,
  `/api/auth/*` and Next's own assets. A page request redirects; an API request gets a 401 body.
- **The gate is coarse by design.** The middleware checks that a session cookie exists. The
  authorization decision lives at the gateway, which authenticates the token on every data call and
  scopes every row to its owner. Where `VEXA_INTERNAL_API_SECRET` is configured, `lib/session.ts`
  additionally verifies the token against admin-api's oracle on each page render, so a revoked
  token is refused here rather than one hop later.
- **The API key never reaches the browser.** It lives in an httpOnly cookie, is read server-side,
  and is attached by the proxy. There is **no environment-key fallback**: a multi-user surface that
  fell back to one deployment-wide key would serve one identity's meetings to whoever was at the
  keyboard. No cookie means 401.
- **One door, closed by default.** `/api/vexa/*` matches a closed allowlist
  (`src/lib/upstream.ts`): `meetings`, `transcripts/by-id/<id>`, `transcripts/<platform>/<native>`.
  GET only. Anything else is a 404 here, not a forwarded probe. Query parameters are filtered to a
  paging allowlist. Ids are shape-checked before they are interpolated.
- **Least privilege on the minted token.** Sign-in mints `bot,tx` — not the `browser` scope the
  terminal needs. Login tokens are named `dashboard-login` and capped, so a sign-in loop cannot
  mint without bound; self-serve and terminal tokens are never touched.
- **Headers.** A nonce-based CSP (no `unsafe-inline` for scripts; no `unsafe-eval` in production),
  `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, a `Permissions-Policy` that denies every
  device capability, COOP/CORP, and HSTS on HTTPS deployments. No `X-Powered-By`.
- **Write guards.** Sign-in and sign-out are POST, same-origin only, and sign-in is rate limited
  (5 per 10 minutes per caller, in-process — a multi-instance deployment puts the real limit at the
  ingress). NextAuth carries its own CSRF token.
- **Redirects.** The `next` parameter is accepted only as a same-site path; `//host`, `/\host` and
  absolute URLs collapse to `/`.
- **The container runs as `node`, not root.**

## What it deliberately does not do

No bot dispatch, no recordings playback, no agent/chat, no admin panel, no token management. Those
live in the Terminal, and adding them here would mean widening the allowlist above. The scope is
the guarantee.

## Layout

```
src/
  middleware.ts   the gate + the security headers — every request passes through
  app/            routes: /, /login, /meetings/[id], and the api/ handlers
  components/     the UI: shell, list, detail, login card
  lib/            session · adminApi · upstream allowlist · meeting mapping · security
```
