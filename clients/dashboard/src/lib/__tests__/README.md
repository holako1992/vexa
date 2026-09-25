# `src/lib/__tests__/` — behavioral tests

Four files, covering the parts where being wrong is expensive:

- `upstream.test.ts` — the allowlist as a table, weighted towards what it **refuses**: unknown
  edges, traversal segments, a non-numeric row id, unfiltered query parameters, an unknown
  platform or separator-bearing native id on the DB-41/DB-42 routes (`bots/status`, `DELETE
  bots/<platform>/<native>`, `meetings/<id>/summary`, `meetings/<platform>/<native>/participants`,
  `POST meetings/<id>/annotate`, `DELETE meetings/<id>`) — and that the summary route's resolved
  path leaves no room for a second, caller-supplied `path=`.
- `security.test.ts` — the properties an operator relies on: scripts are nonced and never
  `unsafe-inline`, production has no `unsafe-eval`, framing is closed, HSTS only on HTTPS, the
  cross-origin write guard, the rate-limit window, and `safeNext()` against every open-redirect
  shape.
- `meetings.test.ts` — honest title fallbacks, phase bucketing, the derived `stopped` status,
  duration only when both ends are known and ordered, and a transcript mapping that keeps the
  producer's order and attribution.
- `summary.test.ts` — the `summary.v1` parser, weighted towards **malformed** input: missing
  front matter, an unclosed front-matter fence, an unknown/missing version, a wrong front-matter
  type, a missing status, a missing required section (one, and all four), and a `skipped` note
  with no `reason` — each its own distinct `{kind: "malformed", detail}`, plus the two well-formed
  shapes (`complete`, `skipped`) parsed correctly.

Run: `npm test`.
