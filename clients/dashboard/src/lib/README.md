# `src/lib/` — the seams

- **`session.ts`** — the ONE place a request's identity is established and the only writer of the
  session cookies. Two tiers, kept distinct: `sessionToken()` is the credential sent upstream;
  `currentUser()` is the identity, verified against admin-api's oracle where configured.
- **`startupConfig.ts`** — the production start-up refusal (`src/instrumentation.ts` calls it): a production server without `VEXA_INTERNAL_API_SECRET` does not start; dev, test and the build phase are never refused.
- **`accountApi.ts`** / **`account.ts`** — the account page. `accountApi.ts` is server-only: it
  resolves the caller's user id from the identity oracle (never from a request), reads the user's
  record and `dashboard-login` tokens from admin-api, and revokes them all. `account.ts` is the
  client-safe half: the shapes, the sentences for each recorded sign-in door, initials, and the
  fixed `/login?notice=` sentence.
- **`adminApi.ts`** — server-only admin-api client: find-or-create by email (forwarding the user's
  address as `X-Forwarded-For` on the create call, recording how the sign-in proved the address —
  provenance on create, a verified upgrade on an existing account — and returning a typed refusal on failure), mint the login token,
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
  The annotate write route carries a body check (`lib/annotations.ts`'s `isAnnotateBody`): a
  rename, or exactly one of the dashboard's two metadata keys, and nothing else. `GET /meetings`
  admits `metadata` only as a single-tag filter. DB-40 adds the one SSE route,
  `meetings/<id>/stream` → `/agent/meeting/stream?meeting_id=<id>&session_uid=<id>` (`sse: true`),
  whose query is composed from the numeric id alone.
  `POST /agent/chat` (streamed, `eventStream`) and
  `POST /agent/chat/reset` admit only the bodies `lib/chat.ts` builds; every other `/agent/*` path
  stays refused.
- **`liveTranscript.ts`** — DB-40's live feed, pure: an incremental `text/event-stream` parser,
  `isLiveCursor` (the producer's `Last-Event-ID` shape — `<transcript>|<output>[|<processed>]`,
  each part a redis stream id, `-` or `$` — the proxy forwards nothing else), `decodeLiveEvent`
  (agent-api's `transcript` and `retract` events mapped onto the REST segment's own field names,
  `meeting-end`; every copilot/transport event ignored), and `applyLiveOps`/`pruneLiveOps` — the one
  merge rule: replace a known `segment_id` in place, append a new one, drop a retracted one, never
  re-sort.
- **`liveStream.ts`** — DB-40's browser connection: `fetch` reading the stream (not `EventSource`,
  which hides the status and reconnects on its own), `streaming`/`polling` modes, reconnect with
  `Last-Event-ID` after a drop, a doubling backoff when the stream never delivered an event (the
  gateway relays agent-api's refusal as a `200 text/event-stream` with a JSON body), a silence
  watchdog above the producer's 15s ping, and `meeting-end` as the only stop.
- **`sseProxy.ts`** — DB-40's server hop for `route.sse`: streams the gateway's body through
  unbuffered (opening with an SSE comment so the browser gets the response head at once), forwards
  only a well-formed `Last-Event-ID`, answers `no-cache, no-store, no-transform` with
  `X-Accel-Buffering: no`, aborts the upstream when the browser leaves, and passes a non-2xx
  through with its own status.
- **`annotations.ts`** — the two caller-owned metadata keys the dashboard writes, `tags` and
  `speaker_labels`: their bounds, readers that skip a malformed value another writer left behind,
  `nextSpeakerLabels` (blank or unchanged removes a label; empty becomes `null`), and the shape
  checks `upstream.ts` uses. Pure, and safe against a speaker literally named `__proto__`.
- **`export.ts`** — DB-45's transcript exports from the lines the page shows: SubRip, WebVTT,
  Markdown, and a minimal .docx written as a stored ZIP by its own small writer, so no document
  library ships. Every format keeps every line, in order, under the shown speaker name.
- **`security.ts`** — the CSP, the header set, the cookie-security decision, the same-origin write
  guard, and `safeNext()` (the open-redirect guard on the post-login target).
- **`signInRefusal.ts`** — the closed set of sign-in refusal codes and their fixed copy, plus the
  typed `SignInRefusal` read off admin-api's response. `/login` turns a code into words and never
  reflects free text from the query string. Client-safe.
- **`rateLimit.ts`** — `clientAddress()` (the caller's address, trusted from `X-Forwarded-For` only
  under `DASHBOARD_TRUST_PROXY`; also what `adminApi.ts` forwards on sign-up) and a fixed-window limiter for the credential endpoints. Per-process and
  in-memory; it bounds one instance and says so.
- **`meetings.ts`** — the shapes the UI renders and the mapping onto them. Presentation only: it
  picks a title, buckets a status, formats a time. It never reshapes a transcript. DB-48 adds
  `MeetingsPageDTO` (the list envelope, `has_more` read verbatim off `GET /meetings` — meeting-api
  forwards the store's own flag rather than the caller guessing from page length) and
  `mergeMeetingsPage` (the one rule for combining a fetched page with what is already loaded —
  "append" for Load more, "replace" for the phase-aware poll's full-window re-fetch, which is what
  keeps a live row on a later page from dropping off). DB-33 adds `autoJoin`/`autoJoinError`/
  `calendarName` onto `Meeting` (all verbatim off the producer's `data.*`) and
  `groupUpcomingByDay` — the Upcoming page's one grouping rule, soonest day and soonest meeting
  within a day first, a row with no resolvable time sorting last under its own group rather than
  crashing the page. DB-43/47 add `tags` and `speakerLabels` onto `Meeting` (from
  `data.metadata`), `end` and `sourceSpeaker` onto `TranscriptLine`, `distinctSpeakers`,
  `sortMeetingsBy` (live always on top) and `loadedTags`.
- **`calendarOAuth.ts`** — the one place both calendar OAuth providers' shared shape lives:
  `CalendarOAuthProvider`, `CALENDAR_OAUTH_LABEL`, and `fetchTrustedAuthorizeUrl` (the
  `GET /user/calendars/<provider>/authorize` call PLUS the authorize-URL host check, so
  `SendBotDialog`'s connect buttons and `CalendarHealthView`'s Reconnect action can't drift on
  what "trusted" means for either provider).
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
- **`chat.ts`** — DB-61's assistant chat wire. Builds the two bodies the panels send to
  `POST /agent/chat` (one meeting row in its own `dashboard-meeting-<id>` thread, or the search
  page's `dashboard-all-meetings` thread with the schedule digest and no focus) and the
  `/agent/chat/reset` body; `isChatTurnBody`/`isChatResetBody`, the exact-shape checks
  `upstream.ts` runs on them; `SseDecoder`, which reads the producer's `data:` frames and keeps any
  non-SSE text (an agent-api refusal the gateway relays inside a 200) as `stray`;
  `streamChatTurn`/`resetChat`; and the plain-words messages for each way a turn ends without an
  answer.
- **`eventStreamProxy.ts`** — DB-61's streamed write hop for `route.ts` (`eventStream: true` in
  `upstream.ts`): relays the gateway's `text/event-stream` chunk by chunk with no response
  timeout, aborts the upstream fetch when the browser disconnects, passes a non-stream refusal
  back as JSON with its own status, and sends only its own fixed response headers.
- **`entitlements.ts`** — shapes and pure formatters for `GET /user/entitlements` (DB-74's billing
  page, DB-75's paywall): usage meters that never render unknown (`null`) as `0`, an unlimited
  plan's limit (`null`) that never renders as a number, the reset date in words, and
  `isQuotaExceeded`, which recognizes DB-72's unwrapped `402 {"error": "quota_exceeded", ...}`
  body — the shape `POST /bots` actually sends, with no `{"detail": ...}` envelope; and
  `reasonMessage`, the fixed sentence for the core's `identity_unverified` reason (any code it has no
  words for renders as nothing, never as raw text).
