/** Canned gateway data for the stub server — one small, realistic world, reused by every spec.
 *
 *  `MEETING_ROWS` spans the three phases the list groups by (`src/lib/meetings.ts`'s `phaseOf`):
 *  live, past (including a user-stopped `completed` row so the "stopped" derived status has a
 *  fixture too), and "scheduled" — three of those: 103 (hand-scheduled, no calendar source), and
 *  DB-33's 110/111 (110 calendar-managed with a `calendar_name` source chip; 111 hand-scheduled,
 *  auto-join already off, carrying a recorded `auto_join_error`, on the same day as 110 but
 *  earlier — the Upcoming page's day-grouping/ordering spec needs both a source chip AND a
 *  same-day ordering case). The past meeting with a native id keeps a full, multi-speaker
 *  transcript with offsets, for the detail-page and search specs.
 *
 *  `freshMeetings()` / `freshCalendars()` return DEEP clones — the stub server mutates its
 *  working copies (new calendars, bot dispatches don't change meetings here, but calendars do),
 *  and a shared reference would leak state across tests that don't call `/__control/reset`
 *  strictly in order.
 */

const MEETING_ROWS = [
  {
    id: 101,
    platform: "google_meet",
    native_meeting_id: "abc-defg-hij",
    status: "active",
    shared: false,
    start_time: "2026-09-18T09:00:00Z",
    end_time: null,
    constructed_meeting_url: "https://meet.google.com/abc-defg-hij",
    data: {
      title: "Weekly Sync",
      attendees: [{ email: "amy@e2e.test", name: "Amy" }, { email: "ben@e2e.test", name: "Ben" }],
      recordings: [],
    },
  },
  {
    id: 102,
    platform: "zoom",
    native_meeting_id: "1234567890",
    status: "completed",
    shared: false,
    start_time: "2026-09-15T14:00:00Z",
    end_time: "2026-09-15T14:42:30Z",
    constructed_meeting_url: "https://zoom.us/j/1234567890",
    data: {
      title: "Design Review",
      attendees: [{ email: "carla@e2e.test", name: "Carla" }, { email: "dev@e2e.test", name: "Dev" }],
      recordings: [{ id: "rec-1" }],
    },
  },
  {
    id: 103,
    platform: "teams",
    native_meeting_id: null,
    status: "scheduled",
    shared: false,
    start_time: null,
    end_time: null,
    constructed_meeting_url: null,
    data: { title: "Roadmap Planning", scheduled_at: "2026-09-25T16:00:00Z", attendees: [] },
  },
  {
    id: 104,
    platform: "jitsi",
    native_meeting_id: "standup@meet.e2e.test",
    status: "completed",
    shared: true,
    start_time: "2026-09-10T08:00:00Z",
    end_time: "2026-09-10T08:15:00Z",
    constructed_meeting_url: "https://meet.e2e.test/standup",
    data: { title: "Daily Standup", stop_requested: true, attendees: [] },
  },
  // 105 — completed, OWNED, no summary.md written yet: the 404-means-"pending" state (DB-60).
  {
    id: 105,
    platform: "zoom",
    native_meeting_id: "5550001111",
    status: "completed",
    shared: false,
    start_time: "2026-09-19T10:00:00Z",
    end_time: "2026-09-19T10:20:00Z",
    constructed_meeting_url: "https://zoom.us/j/5550001111",
    data: { title: "Support Retro", attendees: [] },
  },
  // 106 — completed, a `status: skipped` summary.v1 (too little transcript to summarize).
  {
    id: 106,
    platform: "google_meet",
    native_meeting_id: "skip-defg-hij",
    status: "completed",
    shared: false,
    start_time: "2026-09-19T11:00:00Z",
    end_time: "2026-09-19T11:05:00Z",
    constructed_meeting_url: "https://meet.google.com/skip-defg-hij",
    data: { title: "Quick Check-in", attendees: [] },
  },
  // 110 — scheduled, calendar-managed (imported by a Google connection): DB-33's Upcoming page
  // reads `data.calendar_name` for the source chip and `data.auto_join` for the Join toggle's
  // initial state (on, here).
  {
    id: 110,
    platform: "google_meet",
    native_meeting_id: "gcal-plan-1",
    status: "scheduled",
    shared: false,
    start_time: null,
    end_time: null,
    constructed_meeting_url: "https://meet.google.com/gcal-plan-1",
    data: {
      title: "Quarterly Review",
      scheduled_at: "2026-09-28T15:00:00Z",
      calendar_name: "Work — Google",
      calendar_connection_id: "cal-g1",
      auto_join: true,
      attendees: [],
    },
  },
  // 111 — scheduled by hand (no calendar source, so no chip), on the SAME day as 110 but earlier
  // — proves within-day ordering — and carrying a recorded auto-join skip reason plus auto_join
  // already off, DB-33's "surfaced verbatim" acceptance.
  {
    id: 111,
    platform: "unknown",
    native_meeting_id: null,
    status: "idle",
    shared: false,
    start_time: null,
    end_time: null,
    constructed_meeting_url: null,
    data: {
      title: "1:1 with Priya",
      scheduled_at: "2026-09-28T09:00:00Z",
      auto_join: false,
      auto_join_error: "another meeting is already active for this bot",
      attendees: [],
    },
  },
];

/** DB-48: enough ADDITIONAL rows to force `GET /meetings` past one page at the dashboard's own
 *  page size (20) — `Archived Call 1`..`Archived Call 19`, ids 200..218, oldest-looking first so
 *  they sort after the eight named rows above. 8 + 19 = 27 total: page one (limit 20, offset 0)
 *  returns 20 rows (all eight named ones plus the first 12 archived ones) with `has_more: true`,
 *  page two (offset 20) returns the remaining 7 with `has_more: false` (no third page). */
const ARCHIVED_ROWS = Array.from({ length: 19 }, (_, i) => {
  const n = i + 1;
  const day = String(20 + (i % 8)).padStart(2, "0"); // spreads across a few August dates
  return {
    id: 200 + i,
    platform: "zoom",
    native_meeting_id: `archived-${n}`,
    status: "completed",
    shared: false,
    start_time: `2026-08-${day}T09:00:00Z`,
    end_time: `2026-08-${day}T09:20:00Z`,
    constructed_meeting_url: `https://zoom.us/j/archived-${n}`,
    data: { title: `Archived Call ${n}`, attendees: [] },
  };
});

const ALL_MEETING_ROWS = [...MEETING_ROWS, ...ARCHIVED_ROWS];

/** `summary.v1` notes, keyed by meeting row id — the raw `content` of `meetings/<id>/summary.md`,
 *  exactly the shape `lib/summary.ts` parses. 101 (live) and 103 (scheduled) intentionally have
 *  none: the dashboard must never fetch a summary for a meeting that hasn't ended. 104 (shared)
 *  has none either — a viewer who isn't the owner reads someone else's workspace, which this
 *  stub cannot fake without also faking ownership; the dashboard doesn't fetch it for that case
 *  either. 105 has no entry on purpose — its summary "hasn't been generated yet" (404).
 */
const SUMMARIES = {
  102: `---
type: meeting-summary
version: v1
meeting_id: 102
status: complete
generated_at: 2026-09-15T14:45:00Z
---

## Overview
The team reviewed the redesigned onboarding flow and the new calendar connection screen.

## Decisions
Ship the onboarding empty-state redesign as-is; hold the calendar screen for one more pass.

## Action items
- Dev to open a follow-up on the calendar screen's copy.
- Carla to schedule a design review for next week.

## Open questions
_none recorded in this meeting._
`,
  106: `---
type: meeting-summary
version: v1
meeting_id: 106
status: skipped
generated_at: 2026-09-19T11:06:00Z
reason: "fewer than 3 transcript segments"
---
`,
};

/** Segments keyed by meeting row id. 102 and 105 both have one — DB-44's search specs need a term
 *  ("calendar") that hits more than one meeting so grouping has more than one group to prove. */
const TRANSCRIPTS = {
  102: [
    { start: 0, speaker: "Carla", text: "Let's start with the new onboarding flow." },
    { start: 8.5, speaker: "Dev", text: "Sure — I pushed the updated mockups last night." },
    { start: 21, speaker: "Carla", text: "Nice, the empty states read a lot clearer now." },
    { start: 34.2, speaker: "Dev", text: "Agreed. Next up is the calendar connection screen." },
    { start: 50, speaker: "Carla", text: "Let's walk through that one together." },
  ],
  105: [
    { start: 5, speaker: "Sam", text: "Let's also review the calendar sync issue from last week." },
    { start: 40, speaker: "Priya", text: "It looks like the ICS feed timed out twice." },
  ],
};

/** Participants (DB-42), keyed by `<platform>/<native>` — the same two-source shape meeting-api's
 *  own route returns. Only the live meeting (101) has any, so the header control has something
 *  real to render without every fixture meeting needing one. */
const PARTICIPANTS = {
  "google_meet/abc-defg-hij": {
    invited: [{ name: "Amy", email: "amy@e2e.test", partstat: "accepted" }, { name: "Ben", email: "ben@e2e.test" }],
    speakers: ["Amy"],
  },
};

export function freshMeetings() {
  return JSON.parse(JSON.stringify(ALL_MEETING_ROWS));
}

/** DB-44: a crude but real substring search over the fixture transcripts above, shaped exactly
 *  like meeting-api's own response (`meeting_api/collector/app.py`'s `search_transcripts` /
 *  `fakes.py`'s in-memory stand-in) — `{query, hits, count}`, each hit carrying `meeting_db_id`
 *  (never `meeting_id`), `platform`, `native_meeting_id`, `start`, `end`, `speaker`, `rank`,
 *  `snippet`. Reads `meetings` (the stub's current, possibly-mutated working copy) rather than the
 *  static fixture so a deleted meeting's transcript stops surfacing, same as the real store. */
export function searchTranscripts(meetings, q, { limit = 20, offset = 0 } = {}) {
  const needle = (q || "").trim().toLowerCase();
  if (!needle) return [];
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const hits = [];
  for (const [midStr, segments] of Object.entries(TRANSCRIPTS)) {
    const mid = Number(midStr);
    const meeting = byId.get(mid);
    if (!meeting) continue; // deleted since the fixture was seeded
    for (const seg of segments) {
      const low = seg.text.toLowerCase();
      const i = low.indexOf(needle);
      if (i < 0) continue;
      const snippet = seg.text;
      hits.push({
        meeting_db_id: mid,
        platform: meeting.platform,
        native_meeting_id: meeting.native_meeting_id,
        start: seg.start,
        end: seg.start + 2,
        speaker: seg.speaker,
        rank: 1,
        snippet,
      });
    }
  }
  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  const off = Math.max(0, Number(offset) || 0);
  return hits.slice(off, off + lim);
}

export function transcriptFor(id) {
  const key = String(id);
  const numeric = Number(key);
  return TRANSCRIPTS[numeric] ? JSON.parse(JSON.stringify(TRANSCRIPTS[numeric])) : [];
}

/** The raw `summary.md` content for a meeting row id, or `null` when none has been written
 *  (the dashboard must read that as "still generating", a 404). */
export function summaryFor(id) {
  const numeric = Number(id);
  return Object.prototype.hasOwnProperty.call(SUMMARIES, numeric) ? SUMMARIES[numeric] : null;
}

/** `{invited, speakers}` for a `platform/native` pair, or `null` when the stub has nothing for
 *  it — the real route 404s in that case, and so does this one. */
export function participantsFor(platform, native) {
  const key = `${platform}/${native}`;
  return Object.prototype.hasOwnProperty.call(PARTICIPANTS, key)
    ? JSON.parse(JSON.stringify(PARTICIPANTS[key]))
    : null;
}

export function freshCalendars() {
  return [];
}

/** DB-31: the fixed Google account the stub's OAuth exchange always resolves to — one identity
 *  is enough to prove connect, reconnect (matches an existing connection by this SAME email and
 *  clears `reconnect_needed`), and the state/consent failure paths; a spec that needs a SECOND
 *  distinct Google account is out of this task's scope. */
export const E2E_GOOGLE_EMAIL = "person@e2e.test";

/** DB-32/DB-33's Microsoft sibling of `E2E_GOOGLE_EMAIL` — same role, same one-identity scope. */
export const E2E_MICROSOFT_EMAIL = "person@e2e-work.test";

export const JITSI_HOSTS = ["meet.e2e.test"];

// ── DB-74/DB-75: GET /user/entitlements fixtures ────────────────────────────────────────────────
//
// One shape per state a spec needs to prove distinct: a finite plan with room left, the same plan
// exhausted, an unlimited plan, and usage the meter hasn't reported yet (`null` — never `0`, see
// `billing/ports.py`'s `UsageSnapshot`). `freshEntitlements()` is the default the stub answers
// with after every reset; specs that need a different state call `/__control/entitlements`
// (`helpers.ts`'s `setEntitlements`) to swap it before navigating.

const PERIOD = { start: "2026-09-01T00:00:00+00:00", end: "2026-10-01T00:00:00+00:00" };

export function freeEntitlements({ used = 0 } = {}) {
  return {
    plan_id: "free",
    catalog_version: "2026-09-18",
    status: null,
    will_renew: true,
    grace_until: null,
    period: PERIOD,
    limits: {
      meetings_per_month: 1,
      max_minutes_per_meeting: 60,
      concurrent_bots: 1,
      recording_retention_days: 7,
      ai_summaries_per_month: 1,
    },
    usage: { meetings_used: used, minutes_used: used * 22 },
  };
}

export function proUnlimitedEntitlements() {
  return {
    plan_id: "pro",
    catalog_version: "2026-09-18",
    status: "active",
    will_renew: true,
    grace_until: null,
    period: PERIOD,
    limits: {
      meetings_per_month: null,
      max_minutes_per_meeting: 240,
      concurrent_bots: 2,
      recording_retention_days: 365,
      ai_summaries_per_month: null,
    },
    usage: { meetings_used: 14, minutes_used: 612 },
  };
}

export function pastDueEntitlements() {
  return {
    plan_id: "pro",
    catalog_version: "2026-09-18",
    status: "past_due",
    will_renew: false,
    grace_until: "2026-10-08T00:00:00+00:00",
    period: PERIOD,
    limits: {
      meetings_per_month: null,
      max_minutes_per_meeting: 240,
      concurrent_bots: 2,
      recording_retention_days: 365,
      ai_summaries_per_month: null,
    },
    usage: { meetings_used: 3, minutes_used: 90 },
  };
}

export function unknownUsageEntitlements() {
  const e = freeEntitlements();
  e.usage = { meetings_used: null, minutes_used: null };
  return e;
}

/** The unwrapped 402 body DB-72's quota enforcement sends (`meeting_api/bot_spawn/router.py`) —
 *  no `{"detail": ...}` envelope, so a spec proving the paywall message must see this exact shape
 *  reach the dashboard, not a generic 402. */
export const QUOTA_EXCEEDED_BODY = {
  error: "quota_exceeded",
  limit: 1,
  used: 1,
  resets_at: "2026-10-01T00:00:00Z",
  upgrade_url: null,
};
