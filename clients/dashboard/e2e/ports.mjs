/** The three fixed ports the e2e harness wires together, in one place so the stub server, the
 *  Playwright config, and every spec agree on the same numbers without importing each other's
 *  runtime code (the stub is a separate OS process; specs and the config are not).
 *
 *  Picked in the high range used elsewhere in this repo for local-only test infrastructure, to
 *  stay clear of the dashboard's own dev port (3001) and the real gateway's default (18056).
 */
export const GATEWAY_PORT = 18211;
export const ADMIN_PORT = 18212;
export const DASHBOARD_PORT = 3100;

export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
export const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;
export const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

/** The admin-api key the stub expects on every admin-api call, and the dashboard is configured
 *  to send. Not a secret — it only ever authenticates a request to a stub that exists for the
 *  lifetime of one test run. */
export const ADMIN_API_KEY = "e2e-stub-admin-key";

/** The internal-oracle secret for `POST /internal/validate` (lib/adminApi.ts's
 *  `validateAuthToken`). Configuring it means the dashboard's identity oracle path is exercised
 *  for real, not skipped as "not configured". */
export const INTERNAL_API_SECRET = "e2e-stub-internal-secret";

/** Email addresses allowed through the debug email-login door for these specs. */
export const EMAIL_LOGIN_PATTERN = "@e2e\\.test$";
