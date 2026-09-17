# `src/app/api/vexa/` — the one door to the backend

Every browser call to Vexa data goes through `[...path]/route.ts`. The path table is
`src/lib/upstream.ts`, and it is a closed allowlist: `meetings`, `transcripts/by-id/<id>`,
`transcripts/<platform>/<native>`. GET only.

An allowlist rather than a denylist because the gateway fronts far more than this client needs
(bots, agent, workspace). A catch-all proxy would hand a browser every one of those edges under the
signed-in user's key.
