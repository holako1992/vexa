# `src/lib/__tests__/` — behavioral tests

Five files, covering the parts where being wrong is expensive (plus `api.test.ts`, `entitlements.test.ts` and `meetingId.test.ts`, each already self-explanatory from its own name and the DTOs it exercises):

- `upstream.test.ts` — the allowlist as a table, weighted towards what it **refuses**: unknown
  edges, traversal segments, a non-numeric row id, an unknown platform or separator-bearing native
  id on the DB-41/DB-42 routes (`bots/status`, `DELETE bots/<platform>/<native>`,
  `meetings/<id>/summary`, `meetings/<platform>/<native>/participants`, `POST
  meetings/<id>/annotate`, `DELETE meetings/<id>`) — and that the summary route's resolved path
  leaves no room for a second, caller-supplied `path=`. DB-44/DB-48's `filterQuery` table is
  weighted the same way, PER ROUTE: `q` dropped on `meetings` (a route that never declared it,
  proving one route's param can't leak onto another's), `q` dropped entirely on a route with no
  `query` shape at all, an over-512-char `q` refused rather than truncated, non-numeric/negative/
  out-of-range `limit` and `offset` dropped, and the boundary values (1, 100, 0, 512) kept.
  DB-74b adds `POST /billing/checkout`/`POST /billing/portal` to the same table plus `validateBody`
  itself: the exact `{plan, interval}` shape checkout requires (a paid catalog plan, `month`/`year`
  only, no extra keys, `free`/`monthly`/`yearly`/wrong types/non-object bodies all refused),
  portal's empty-body-only shape, and a proof that a route with no `body` validator (every write
  route older than DB-74b) still admits anything, unchanged.
- `security.test.ts` — the properties an operator relies on: scripts are nonced and never
  `unsafe-inline`, production has no `unsafe-eval`, framing is closed, HSTS only on HTTPS, the
  cross-origin write guard, the rate-limit window, `safeNext()` against every open-redirect shape,
  and (DB-74b) `isTrustedBillingRedirect()` against every Stripe-host near-miss (a look-alike
  domain, a non-`https` scheme, a malformed string) before the billing page ever navigates there.
- `meetings.test.ts` — honest title fallbacks, phase bucketing, the derived `stopped` status,
  duration only when both ends are known and ordered, a transcript mapping that keeps the
  producer's order and attribution, and DB-48's `mergeMeetingsPage` (append de-duplicates by id;
  replace drops a row missing from the fresh window rather than carrying it over stale, and keeps
  live rows sorted first regardless of the fresh page's own order).
- `search.test.ts` — DB-44's `groupHitsByMeeting` (repeated hits collapse into one group, groups
  keep first-seen/producer-rank order, never re-sorted) and `highlightSnippet` (a single term,
  every case-insensitive occurrence of a repeated term, a quoted phrase as one unit, a `-negated`
  term never highlighted, an HTML-looking term rendered as plain text — never
  `dangerouslySetInnerHTML`).
- `summary.test.ts` — the `summary.v1` parser, weighted towards **malformed** input: missing
  front matter, an unclosed front-matter fence, an unknown/missing version, a wrong front-matter
  type, a missing status, a missing required section (one, and all four), and a `skipped` note
  with no `reason` — each its own distinct `{kind: "malformed", detail}`, plus the two well-formed
  shapes (`complete`, `skipped`) parsed correctly.

Run: `npm test`.
