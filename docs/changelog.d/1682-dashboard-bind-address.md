- **The dashboard and the terminal can be published beyond loopback (#1682).** Both still bind
  loopback by default (`127.0.0.1:13002` and `127.0.0.1:13000`). `DASHBOARD_NEXT_BIND=0.0.0.0` and
  `TERMINAL_BIND=0.0.0.0` publish them on the host's IP; set `DASHBOARD_NEXT_URL` (and `NEXTAUTH_URL`
  for the terminal) to the origin people use. Every other service stays on loopback. The dashboard
  README explains why a domain with TLS is the supported way to expose them: OAuth providers refuse a
  bare-IP redirect URI, plain http sends the session cookie unencrypted, and the terminal's
  type-an-email door is open to any address containing "test".
