# `src/lib/__tests__/` — behavioral tests

Seventeen files, covering the parts where being wrong is expensive (plus `api.test.ts`, `entitlements.test.ts`, `meetingId.test.ts` and `calendarOAuth.test.ts`, each already self-explanatory from its own name and the DTOs it exercises):

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
  route older than DB-74b) still admits anything, unchanged. DB-50 adds the recordings surface:
  `GET /recordings` (with `meeting_id`/`limit`/`offset`), `GET /recordings/<id>/master` and the
  `raw`/`download` media-byte pair (`type=audio|video` only, a non-numeric recording or media-file
  id refused, `download` and `raw` proven to resolve to the SAME gateway path since the gateway
  itself treats them as aliases), and `DELETE /recordings/<id>`.
- `annotations.test.ts` — tags and speaker labels, weighted towards what `isAnnotateBody` refuses
  (any metadata key the dashboard does not own, two keys at once, an empty list or map, an
  untrimmed or over-long name, an un-normalized tag), the single-tag list filter, and a speaker
  named `__proto__` or `constructor` read as an ordinary name, never off the prototype.
- `export.test.ts` — every export format round-tripped back to its lines: SubRip/WebVTT cue
  timing (the producer's end, else the next later start, else a fixed length; a line with no
  offset kept, not dropped), WebVTT markup escaping, Markdown inline escaping, and the .docx read
  back out of its own ZIP with every entry's CRC checked, control characters dropped, and the same
  bytes for the same transcript.
- `authProvenance.test.ts` — what each sign-in door tells admin-api about the address: Google's
  `email_verified` is read literally (only a boolean `true` verifies; absent, string, numeric and
  non-object profiles do not) and a Microsoft sign-in counts as verified.
- `startupConfig.test.ts` — only a production server without the oracle secret is refused (blank and whitespace count as missing); development, test and the production build phase never are.
- `signInRefusal.test.ts` — admin-api's typed disposable-domain refusal becomes a code; an unknown
  code, unparseable body or non-4xx failure becomes the generic or "unavailable" code; and a
  `?error=` value that is not a known code (NextAuth names, hostile text, `__proto__`) yields the
  generic sentence, never itself.
- `adminApi.test.ts` (also: the identity provenance goes out on the create call; an existing account is
  only ever upgraded, by a PATCH that carries a verified claim, never an unverified one, and a failed
  upgrade does not fail the sign-in) — `clientAddress()` with trust-proxy off (a client-set `X-Forwarded-For` is not an
  address) and on; `forwardedForHeader()` sends only a plain IP literal (a list or a header-injection
  string is dropped); and `findOrCreateUserToken` sends `X-Forwarded-For` on the create call only,
  omits it when the address is unknown, and returns a typed refusal for the 422.
- `rawStream.test.ts` — DB-50's ONE non-JSON hop: `rawRequestHeaders` forwards a `Range` header
  verbatim and nothing else, `rawResponseHeaders` copies exactly `content-type`/`content-length`/
  `content-range`/`accept-ranges` plus `Cache-Control: no-store` — weighted towards proving a
  header OUTSIDE that fixed list (`Set-Cookie`, a trace header) never rides along, and a header
  the upstream didn't send (no `Content-Range` on a full, non-Range 200) is omitted rather than
  invented as empty.
- `security.test.ts` — the properties an operator relies on: scripts are nonced and never
  `unsafe-inline`, production has no `unsafe-eval`, framing is closed, HSTS only on HTTPS, the
  cross-origin write guard, the rate-limit window, `safeNext()` against every open-redirect shape,
  and (DB-74b) `isTrustedBillingRedirect()` against every Stripe-host near-miss (a look-alike
  domain, a non-`https` scheme, a malformed string) before the billing page ever navigates there.
- `meetings.test.ts` — honest title fallbacks, phase bucketing, the derived `stopped` status,
  duration only when both ends are known and ordered, a transcript mapping that keeps the
  producer's order and attribution, and DB-48's `mergeMeetingsPage` (append de-duplicates by id;
  replace drops a row missing from the fresh window rather than carrying it over stale, and keeps
  live rows sorted first regardless of the fresh page's own order). DB-50 adds `recordingId` (the
  first `data.recordings[]` entry's id, `null` on an empty/id-less list); DB-51 adds
  `activeSegmentIndex` (the LATEST segment at or before `currentTime`, never the nearest — proven
  against a segment with no offset at all, and that it sticks on the last segment once playback
  runs past it).
- `recordings.test.ts` — DB-50/52's `/recordings` list mapping: `toRecording` picks the AUDIO
  entry out of `media_files[]` (never video, never the first entry regardless of type), is `null`
  on `audioMediaFileId` for a video-only or still-uploading recording, and falls back to an honest
  `"unknown"` status and a dropped (never `NaN`) duration. `formatRetention` proves the
  `null`-means-unlimited rule every other entitlements formatter follows, plus the day/month/year
  render cases; `formatRecordedAt` proves the honest "Unknown date" fallback.
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
