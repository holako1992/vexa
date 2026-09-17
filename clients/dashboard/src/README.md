# `src/` — the dashboard's source

Three layers and one file that sits above them.

- **`middleware.ts`** — every request enters here. It gates unauthenticated access and stamps the
  security headers (including the per-response CSP nonce) onto whatever the app returns.
- **`app/`** — routes. Server components resolve identity and hand it down; the `api/` handlers are
  the only code that talks to a backend.
- **`components/`** — the UI. Client components, given their data as props or fetched through
  `lib/api.ts`. None of them knows a backend host.
- **`lib/`** — the seams: session, admin-api client, the proxy allowlist, the meeting/transcript
  mapping, the security policy. The pure ones are tested in `lib/__tests__`.

The direction of dependency is one-way: `app/` and `components/` use `lib/`, never the reverse.
