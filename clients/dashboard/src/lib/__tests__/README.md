# `src/lib/__tests__/` — behavioral tests

Three files, covering the parts where being wrong is expensive:

- `upstream.test.ts` — the allowlist as a table, weighted towards what it **refuses**: unknown
  edges, traversal segments, a non-numeric row id, unfiltered query parameters.
- `security.test.ts` — the properties an operator relies on: scripts are nonced and never
  `unsafe-inline`, production has no `unsafe-eval`, framing is closed, HSTS only on HTTPS, the
  cross-origin write guard, the rate-limit window, and `safeNext()` against every open-redirect
  shape.
- `meetings.test.ts` — honest title fallbacks, phase bucketing, the derived `stopped` status,
  duration only when both ends are known and ordered, and a transcript mapping that keeps the
  producer's order and attribution.

Run: `npm test`.
