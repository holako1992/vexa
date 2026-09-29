- **The dashboard can be published beyond loopback (#1682).** `dashboard-next` still binds
  `127.0.0.1:13002` by default; setting `DASHBOARD_NEXT_BIND=0.0.0.0` (with `DASHBOARD_NEXT_URL` set to
  the origin people use) publishes it on the host's IP. Only the dashboard is affected; every other
  service stays on loopback. The dashboard README explains why a domain with TLS is the supported way
  to expose it: OAuth providers refuse a bare-IP redirect URI and plain http sends the session cookie
  unencrypted.
