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
];

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

export function freshMeetings() {
  return JSON.parse(JSON.stringify(MEETING_ROWS));
}

export function transcriptFor(id) {
  const key = String(id);
  const numeric = Number(key);
  return TRANSCRIPTS[numeric] ? JSON.parse(JSON.stringify(TRANSCRIPTS[numeric])) : [];
}

export function freshCalendars() {
  return [];
}

export const JITSI_HOSTS = ["meet.e2e.test"];
