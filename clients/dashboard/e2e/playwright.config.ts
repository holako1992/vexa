/** Playwright config for the dashboard's browser harness (DB-02).
 *
 *  Two `webServer`s, booted fresh for every run so "green" means "cold start works":
 *    1. the stub backend (`stub-server.mjs`) — both of the dashboard's real upstreams, faked.
 *    2. the dashboard itself (`next dev`), pointed at the stub via the same env vars an operator
 *       would set for a real gateway + admin-api.
 *
 *  `npm run test:e2e` (package.json) runs this config. It is deliberately NOT part of `npm test`
 *  (vitest) — the unit loop must stay fast and dependency-free; this is the slower, real-browser
 *  loop layered on top of it, per AGENTS.md's "the two loops".
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  ADMIN_API_KEY,
  ADMIN_URL,
  DASHBOARD_PORT,
  DASHBOARD_URL,
  EMAIL_LOGIN_PATTERN,
  GATEWAY_URL,
  INTERNAL_API_SECRET,
} from "./ports.mjs";

const dashboardEnv = {
  PORT: String(DASHBOARD_PORT),
  GATEWAY_URL,
  VEXA_ADMIN_API_URL: ADMIN_URL,
  VEXA_ADMIN_API_KEY: ADMIN_API_KEY,
  VEXA_INTERNAL_API_SECRET: INTERNAL_API_SECRET,
  DASHBOARD_ALLOW_EMAIL_LOGIN: "true",
  DASHBOARD_EMAIL_LOGIN_PATTERN: EMAIL_LOGIN_PATTERN,
  // The login route rate-limits by client IP (lib/rateLimit.ts), 5 attempts / 10 minutes, and
  // with no trusted proxy every request shares one "direct" bucket — which nine specs' worth of
  // sign-ins blow through in one run. Trusting X-Forwarded-For here is safe: it is this SAME
  // config's own webServer, not a public deployment, and `helpers.ts`'s `signIn()` sets a fresh
  // one per spec so each behaves like its own client, same as it would in production behind a
  // real proxy.
  DASHBOARD_TRUST_PROXY: "true",
  // Neither OAuth provider is configured — the specs only exercise the email door.
  NEXTAUTH_URL: DASHBOARD_URL,
  NEXTAUTH_SECRET: "e2e-nextauth-secret-not-for-production",
};

// This config runs under Node's ESM loader (`"type": "module"` in package.json), so there is no
// `__dirname` — derive the dashboard package root (this file's parent's parent) the ESM way.
const DASHBOARD_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false, // every spec shares one stub process's mutable state
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: DASHBOARD_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/stub-server.mjs",
      url: `${GATEWAY_URL}/__control/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      cwd: DASHBOARD_ROOT,
    },
    {
      // Not `npm run dev`: that script is `next dev --port ${PORT:-3001}`, a bash-ism. npm always
      // runs package scripts through cmd.exe on Windows regardless of the invoking shell, so the
      // `${PORT:-3001}` never expands there and `next dev` gets a literal, invalid port string.
      // Calling `next` directly with a literal port sidesteps that on every platform.
      command: `npx next dev --port ${DASHBOARD_PORT}`,
      url: `${DASHBOARD_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: DASHBOARD_ROOT,
      env: dashboardEnv,
    },
  ],
});
