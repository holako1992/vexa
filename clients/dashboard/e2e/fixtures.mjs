/** Canned gateway data for the stub server — one small, realistic world, reused by every spec.
 *
 *  Four meetings span the three phases the list groups by (`src/lib/meetings.ts`'s `phaseOf`):
 *  one live, one scheduled, and two past (one of them a user-stopped `completed` row so the
 *  "stopped" derived status has a fixture too). The past meeting with a native id keeps a full,
 *  multi-speaker transcript with offsets, for the detail-page and search specs.
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
];

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

/** Segments keyed by meeting row id — only the fully-transcribed past meeting (102) has one, to
 *  keep the fixture honest about which rows a real deployment would actually have text for. */
const TRANSCRIPTS = {
  102: [
    { start: 0, speaker: "Carla", text: "Let's start with the new onboarding flow." },
    { start: 8.5, speaker: "Dev", text: "Sure — I pushed the updated mockups last night." },
    { start: 21, speaker: "Carla", text: "Nice, the empty states read a lot clearer now." },
    { start: 34.2, speaker: "Dev", text: "Agreed. Next up is the calendar connection screen." },
    { start: 50, speaker: "Carla", text: "Let's walk through that one together." },
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
  return JSON.parse(JSON.stringify(MEETING_ROWS));
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

export const JITSI_HOSTS = ["meet.e2e.test"];
