- **Dashboard: a real browser test harness, against a stubbed gateway + admin-api (#1635).**
  `clients/dashboard/e2e/` adds Playwright (Apache-2.0, pinned at `1.56.0` to match the other
  Playwright consumers in this monorepo) driving a real Chromium against a real `next dev`
  dashboard, itself talking to a real (stubbed, dependency-free) gateway and admin-api over
  actual HTTP — the first harness in this package that isn't a mocked `fetch`. Nine specs cover
  the gate, email sign-in, the meetings list, the single-row detail read (`b92d8de1`'s property,
  proven end to end for the first time), sending a bot, connecting an ICS calendar, the proxy
  allowlist's negative case, the API key never reaching the browser, and the list/detail error
  states. `npm run test:e2e` runs it; `npm test` (vitest) is unaffected and stays dependency-free.
  `node scripts/gates.mjs dashboard-e2e` wires it into the gate suite, skipping cleanly (not
  failing) when `node_modules` or the Chromium binary aren't present on a given host. See
  [`clients/dashboard/e2e/README.md`](https://github.com/Vexa-ai/vexa/blob/main/clients/dashboard/e2e/README.md).
