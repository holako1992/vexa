# `src/lib/` — the seams

- **`session.ts`** — the ONE place a request's identity is established and the only writer of the
  session cookies. Two tiers, kept distinct: `sessionToken()` is the credential sent upstream;
  `currentUser()` is the identity, verified against admin-api's oracle where configured.
- **`adminApi.ts`** — server-only admin-api client: find-or-create by email, mint the login token,
  cap the login tokens, validate a token. It mirrors the terminal's slice rather than importing it
  — the two clients are separate npm projects, and a client must not depend on another client at
  runtime.
- **`upstream.ts`** — the closed allowlist that defines the entire backend surface. Pure, so the
  table is tested directly. Each resolved route declares its OWN permitted query parameters
  (`UpstreamRoute.query`), each with a value-shape check — `limit`/`offset` bounded ints,
  `transcripts/search`'s `q` length-capped at meeting-api's own 512-char limit — rather than one
  global set applied to every proxied GET; see `filterQuery`'s header comment for the incident
  that shape exists to prevent (DB-44 needed a free-text `q` param and a global allowlist would
  have forwarded it to every route, not just the one that asked for it).
- **`security.ts`** — the CSP, the header set, the cookie-security decision, the same-origin write
  guard, and `safeNext()` (the open-redirect guard on the post-login target).
- **`rateLimit.ts`** — a fixed-window limiter for the credential endpoints. Per-process and
  in-memory; it bounds one instance and says so.
- **`meetings.ts`** — the shapes the UI renders and the mapping onto them. Presentation only: it
  picks a title, buckets a status, formats a time. It never reshapes a transcript. DB-48 adds
  `MeetingsPageDTO` (the list envelope, `has_more` read verbatim off `GET /meetings` — meeting-api
  forwards the store's own flag rather than the caller guessing from page length) and
  `mergeMeetingsPage` (the one rule for combining a fetched page with what is already loaded —
  "append" for Load more, "replace" for the phase-aware poll's full-window re-fetch, which is what
  keeps a live row on a later page from dropping off).
- **`search.ts`** — DB-44's two pure transforms for `/search`: `groupHitsByMeeting` (collects
  `GET /transcripts/search`'s flat hit list into per-meeting groups, in the producer's own rank
  order) and `highlightSnippet` (splits a snippet into plain/matched text segments for the
  component to render as `<mark>` — a data transform, never HTML; nothing here calls
  `dangerouslySetInnerHTML`).
- **`api.ts`** — the browser fetch helper. Fails loud, so a failure never degrades into an empty
  list. `ApiError` carries the parsed response body (`.body`), not just a squashed `.detail`
  string, so a caller can branch on a specific error shape (DB-72's unwrapped `quota_exceeded`
  402) instead of losing it to the generic status-keyed sentence.
- **`summary.ts`** — parses the `summary.v1` note DB-60 writes (front matter + four `##`
  sections) into data `SummaryPanel.tsx` renders. Dependency-free, like `upstream.ts`; malformed
  input (missing front matter, an unknown version, a missing section) is its own `{kind:
  "malformed"}` value, never silently coerced into "skipped" or an empty complete note. Also
  parses the note's inline `**strong**` / `_emphasis_` markdown into safe segments
  (`parseInlineEmphasis`) — an underscore is a delimiter only at a word boundary, so
  `snake_case_name` stays literal.
- **`entitlements.ts`** — shapes and pure formatters for `GET /user/entitlements` (DB-74's billing
  page, DB-75's paywall): usage meters that never render unknown (`null`) as `0`, an unlimited
  plan's limit (`null`) that never renders as a number, the reset date in words, and
  `isQuotaExceeded`, which recognizes DB-72's unwrapped `402 {"error": "quota_exceeded", ...}`
  body — the shape `POST /bots` actually sends, with no `{"detail": ...}` envelope.
