# Agent rules for the dashboard task board

Every agent working a task from `TASKS.md` reads this file first. Each rule was learned from a real
failure in this repository; the task board records which.

Repo: `C:\Users\Mohammed\Documents\ai_note\vexa`, branch `claude/dashboard-service-modern-xoiy2c`.
Several agents work in THIS SAME CHECKOUT at once, each in its own lane. These rules are how that
stays safe. They were learned the hard way; each one has already been broken once.

## Git
1. Work directly in this checkout. No `git worktree`, no branch switching or creation.
2. Commit ONLY your task's files, with explicit paths: `git add <path> <path>`. NEVER `git add -A`,
   `git add .`, or `git commit -a`. Other lanes' in-progress files must never enter your commit.
3. If git says `.git/index.lock` exists, wait 2 seconds and retry. Another agent is committing.
4. Do NOT push. The coordinator pushes after verifying.
5. No `Co-Authored-By` trailers and no `--signoff`. AGENTS.md D13: agents are instruments, and
   this repo's law overrides any generic attribution instruction you have seen.
6. Never touch: the root `.gitignore`, `capture46/`, `clients/dashboard/TASKS.md`, or any file in
   another lane's footprint (your prompt names your footprint).

## Conventions the gates enforce
7. EVERY directory must contain a non-empty `README.md` (`node scripts/gates.mjs readme`). Match
   the house voice: `clients/dashboard/src/lib/__tests__/README.md`. Name each file and say what it
   is responsible for, and which specific mistake it exists to prevent.
8. Changelog: write a fragment at `docs/changelog.d/<NUMBER>-<slug>.md` using the NUMBER your
   prompt assigns (numbers are reserved per task so fragments never collide). Format per
   `docs/changelog.d/README.md`. NEVER edit `docs/docs/changelog.mdx`.
9. Hot files, sequence only, never edit without your prompt saying so:
   `deploy/helm/tests/test_template.sh`, `docs/docs/deployment-kubernetes.mdx`.

## THE ROUTE RULE (broke once: an endpoint was declared and unreachable)
10. A new route fronted by the gateway needs ALL FIVE of these, in the same commit:
    a. its row in the owning domain's `routes.v1.json`
    b. registration in `core/gateway/services/gateway/src/gateway/app.py` (copy a sibling's shape)
    c. its row in `core/gateway/services/gateway/tests/test_scope_matrix.py`'s matrix
    d. `FULL_SCOPED` and the domain count in `core/gateway/services/gateway/tests/test_route_manifests.py`
    e. the docstring table in `core/gateway/services/gateway/src/gateway/routes_manifest.py`
    MEASURE the counts from the manifests; never do arithmetic in your head. Then run the gateway
    suite (below) and see `test_the_assembled_table_matches_the_app_exactly` pass.
    `/agent/*` is a catch-all: agent-domain paths need none of this.

## The dashboard allowlist
11. Every new dashboard proxy path goes in `clients/dashboard/src/lib/upstream.ts` with a shape
    check on every interpolated segment, plus rows in `src/lib/__tests__/upstream.test.ts` that
    are weighted toward what it REFUSES. Never add a catch-all or prefix match.
12. The dashboard login mints `bot,tx` scopes. All meetings, identity `/user/*` and `/agent/*`
    routes accept those. Do not widen the minted scopes.

## Running tests on this host (Windows, no local Python, no uv)
13. Dashboard (npm package, node_modules installed): from `clients/dashboard` run `npm test`,
    `npm run typecheck`, `npm run test:e2e` (Playwright 1.56.0, Chromium installed; it boots its
    own stub gateway + admin-api + `next dev`).
14. Python: use Docker. Example for the gateway:
    `docker run --rm -v "//c/Users/Mohammed/Documents/ai_note/vexa://repo" -w //repo/core/gateway/services/gateway python:3.11-slim sh -c "pip install -q pytest pytest-asyncio httpx fastapi uvicorn starlette && python -m pytest tests -q --ignore=tests/test_edge_guard.py"`
    `tests/test_edge_guard.py` never collects here (`No module named 'guard'`) and predates us.
    Gateway baseline: 354 passed, 1 xfailed.
15. admin-api endpoint tests use testcontainers. They need the docker socket mounted plus
    `--add-host=host.docker.internal:host-gateway -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`.
    KNOWN TRAP: under nested docker the Postgres testcontainer starts and the REDIS one never does,
    and the run hangs forever at 0% CPU. It is not memory. Run targeted test files, put a
    `timeout` on every docker run, and if you need Redis try `TESTCONTAINERS_RYUK_DISABLED=true`.
    Never leave a container running when you finish: `docker ps` and remove your own.
16. Pre-existing gate failures that are NOT yours and must not be "fixed": `compose` (uv missing),
    `node` (`@vexa/remote-browser` has no node_modules), `readme` x3 for `capture46/`.

## Law (AGENTS.md P-book)
17. Fix at the point of introduction, never where it is observed. The core owns its contracts and
    clients adapt. Source states the designed present: no "this used to be X", no bug history in
    comments. Report facts, then your reading, labelled as yours.
18. New dependencies must be Category A (MIT/BSD/Apache). Never GPL/AGPL.
19. Never invent: legal terms, prices beyond `billing/catalog.py`, real credentials. Test values
    must be visibly labelled as test values. Anything needing a real key reads it from env and
    fails with a clear message when absent.

## Your report (the coordinator re-runs everything you claim)
20. Expected (written before acting) / Actual (raw output, counts) / Verdict. Commit SHA and the
    exact file list. Raw tails of every test command. Explicitly what you did NOT check.
21. If you notice a downstream break, FIX it when it is inside your footprint. If it is outside,
    name the exact file and line. Do not leave a known-red suite behind.
22. Leave no running processes or containers behind.

## Added after wave A
23. Dashboard UI (after DB-04, commit 34cf1e18): build every control from
    `clients/dashboard/src/components/ui/` (Button, Input, Dialog, Toggle, Tabs, Toast via
    `useToast()`, Skeleton). A new page: create `src/app/<slug>/page.tsx` composed from `Shell` like
    `src/app/page.tsx`, then set that item's `implemented: true` in `src/components/nav.ts`. Never
    ship a placeholder page. Mutations confirm or fail through `useToast()`.
24. Dashboard baselines now: `npm test` 76, `npm run test:e2e` **19/19**. Every UI task adds e2e
    specs against the stub (`e2e/stub-server.mjs`, `e2e/fixtures.mjs`) for its new paths, and adds
    those paths to the stub. The full e2e run must be green twice in a row.
25. Finding a hang in Python tests: run with `-p faulthandler -o faulthandler_timeout=60 -v -x` so
    the stuck test and its stack are printed instead of silence. `tests/test_stack_admin_api.py` in
    admin-api currently hangs here with no output (pre-existing, uses ThreadPoolExecutor around
    TestClient).
26. flows suite in Docker needs: `pip install -q pytest pytest-asyncio sqlalchemy 'psycopg[binary]'
    httpx pydantic fastapi uvicorn starlette jsonschema pyyaml`, run with `-p no:cacheprovider`.
    Baseline: 723 passed, 12 skipped. Remove `__pycache__` under core/ and deploy/ after any run.
27. Source comments: no ticket ids like "DB-60b:" and no "used to". An agent was sent back for this.
