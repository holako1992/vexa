- **The dashboard client now hot-reloads under the compose dev overlay (#1633).** `docker-compose.hot.yml` gains a
  `dashboard-next` block mirroring the Terminal's: `next dev` under `NODE_ENV=development`, with
  `clients/dashboard/src`, `next.config.ts` and `tsconfig.json` bind-mounted from the host so an edit is live in
  seconds, no rebuild. Because the dashboard's shipped image carries pruned production `node_modules`, running it
  under this overlay needs the full dev dependency tree at runtime; `clients/dashboard/Dockerfile` gains the same
  `RUNTIME_DEPS` build arg the Terminal uses (`DASHBOARD_NEXT_RUNTIME_DEPS=dev` in `.env` selects it).
