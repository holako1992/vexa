/** The row mapper and the transcript mapper — presentation decisions only, so the test pins the
 *  honest fallbacks and the ordering rather than any reshaping (there is none to pin). */
import { describe, expect, it } from "vitest";
import {
  type Meeting,
  type MeetingRowDTO,
  type TranscriptLine,
  activeSegmentIndex,
  distinctSpeakers,
  filterMeetings,
  formatClock,
  groupUpcomingByDay,
  initialsOf,
  loadedTags,
  mergeMeetingsPage,
  sortMeetings,
  sortMeetingsBy,
  toMeeting,
  toTranscript,
  transcriptToText,
} from "../meetings";

const row = (over: Partial<MeetingRowDTO> = {}): MeetingRowDTO => ({
  id: 1,
  platform: "google_meet",
  native_meeting_id: "abc-defg-hij",
  status: "completed",
  ...over,
});

describe("toMeeting", () => {
  it("prefers the user-given title, then platform · code, then an honest fallback", () => {
    expect(toMeeting(row({ data: { title: "Weekly sync" } })).title).toBe("Weekly sync");
    expect(toMeeting(row()).title).toBe("Google Meet · abc-defg-hij");
    expect(toMeeting(row({ native_meeting_id: null, platform: "unknown" })).title).toBe("Untitled meeting");
  });

  it("buckets live, scheduled and past", () => {
    expect(toMeeting(row({ status: "active" })).phase).toBe("live");
    expect(toMeeting(row({ status: "awaiting_admission" })).phase).toBe("live");
    expect(toMeeting(row({ status: "scheduled" })).phase).toBe("scheduled");
    expect(toMeeting(row({ status: "completed" })).phase).toBe("past");
  });

  it("surfaces a user-stopped row as `stopped`, which is not a DB status", () => {
    expect(toMeeting(row({ status: "completed", data: { stop_requested: true } })).status).toBe("stopped");
  });

  it("computes a duration only when both ends are known and ordered", () => {
    const start = "2026-09-01T10:00:00Z";
    expect(toMeeting(row({ start_time: start, end_time: "2026-09-01T10:41:30Z" })).durationSeconds).toBe(2490);
    expect(toMeeting(row({ start_time: start })).durationSeconds).toBeNull();
    expect(toMeeting(row({ start_time: start, end_time: "2026-09-01T09:00:00Z" })).durationSeconds).toBeNull();
  });
});

describe("toMeeting — recordingId", () => {
  it("reads the first recording's id, and hasRecording tracks the same array", () => {
    const m = toMeeting(row({ data: { recordings: [{ id: 555001 }, { id: 555002 }] } }));
    expect(m.hasRecording).toBe(true);
    expect(m.recordingId).toBe("555001");
  });

  it("is null when there is no recording, an empty list, or an id-less entry", () => {
    expect(toMeeting(row()).recordingId).toBeNull();
    expect(toMeeting(row({ data: { recordings: [] } })).recordingId).toBeNull();
    expect(toMeeting(row({ data: { recordings: [{ status: "in_progress" }] } as never })).recordingId).toBeNull();
  });

  it("stringifies a numeric id without losing precision-looking digits", () => {
    expect(toMeeting(row({ data: { recordings: [{ id: "100200300400" }] } })).recordingId).toBe("100200300400");
  });
});

describe("toMeeting — auto-join, calendar source", () => {
  it("defaults autoJoin to true when data.auto_join is absent, honours an explicit false", () => {
    expect(toMeeting(row({ status: "scheduled" })).autoJoin).toBe(true);
    expect(toMeeting(row({ status: "scheduled", data: { auto_join: true } })).autoJoin).toBe(true);
    expect(toMeeting(row({ status: "scheduled", data: { auto_join: false } })).autoJoin).toBe(false);
  });

  it("carries the producer's auto_join_error and calendar_name verbatim, null when absent", () => {
    const withError = toMeeting(row({
      status: "scheduled",
      data: { auto_join_error: "another meeting is already active", calendar_name: "Work — Google" },
    }));
    expect(withError.autoJoinError).toBe("another meeting is already active");
    expect(withError.calendarName).toBe("Work — Google");

    const plain = toMeeting(row({ status: "scheduled" }));
    expect(plain.autoJoinError).toBeNull();
    expect(plain.calendarName).toBeNull();
  });
});

describe("groupUpcomingByDay", () => {
  const scheduled = (id: number, scheduledAt: string | undefined, title: string): Meeting =>
    toMeeting(row({ id, native_meeting_id: null, platform: "unknown", status: "scheduled", data: { scheduled_at: scheduledAt, title } }));

  it("groups by calendar day, soonest day first, soonest meeting first within a day", () => {
    const groups = groupUpcomingByDay([
      scheduled(1, "2026-10-02T14:00:00", "Later on the 2nd"),
      scheduled(2, "2026-10-01T09:00:00", "Morning on the 1st"),
      scheduled(3, "2026-10-01T16:00:00", "Afternoon on the 1st"),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(groups[0]!.meetings.map((m) => m.title)).toEqual(["Morning on the 1st", "Afternoon on the 1st"]);
    expect(groups[1]!.meetings.map((m) => m.title)).toEqual(["Later on the 2nd"]);
  });

  it("sorts a row with no resolvable time last, under its own group", () => {
    const groups = groupUpcomingByDay([
      scheduled(1, "2026-10-01T09:00:00", "Has a date"),
      scheduled(2, undefined, "No date"),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-10-01", "no-date"]);
    expect(groups[1]!.label).toBe("No date set");
  });

  it("returns nothing for an empty list", () => {
    expect(groupUpcomingByDay([])).toEqual([]);
  });
});

describe("sortMeetings", () => {
  it("leads with live meetings, then newest first", () => {
    const list = [
      toMeeting(row({ id: 1, status: "completed", start_time: "2026-09-01T10:00:00Z" })),
      toMeeting(row({ id: 2, status: "completed", start_time: "2026-09-03T10:00:00Z" })),
      toMeeting(row({ id: 3, status: "active", start_time: "2026-08-01T10:00:00Z" })),
    ];
    expect(sortMeetings(list).map((m) => m.id)).toEqual(["3", "2", "1"]);
  });
});

describe("filterMeetings", () => {
  it("matches title, platform, status and attendees, case-insensitively", () => {
    const list = [
      toMeeting(row({ id: 1, data: { title: "Board review" } })),
      toMeeting(row({ id: 2, data: { title: "Standup", attendees: [{ email: "ada@example.com" }] } })),
    ];
    expect(filterMeetings(list, "board").map((m) => m.id)).toEqual(["1"]);
    expect(filterMeetings(list, "ADA@").map((m) => m.id)).toEqual(["2"]);
    expect(filterMeetings(list, "  ").length).toBe(2);
  });
});

describe("toTranscript", () => {
  it("keeps the producer's order and attribution, dropping only blank segments", () => {
    expect(
      toTranscript([
        { start: 0, speaker: "Ada", text: " Hello " },
        { start: 4, speaker: " ", text: "second" },
        { start: 9, speaker: "Ada", text: "   " },
      ]),
    ).toEqual([
      { at: 0, end: null, speaker: "Ada", sourceSpeaker: "Ada", text: "Hello" },
      { at: 4, end: null, speaker: "Unknown speaker", sourceSpeaker: null, text: "second" },
    ]);
  });

  it("survives a missing or malformed segments field", () => {
    expect(toTranscript(undefined)).toEqual([]);
    expect(toTranscript(null)).toEqual([]);
    expect(toTranscript([{ text: "no offset" }])).toEqual([
      { at: null, end: null, speaker: "Unknown speaker", sourceSpeaker: null, text: "no offset" },
    ]);
  });

  it("keeps the producer's end offset, and drops a non-finite one", () => {
    const [a, b] = toTranscript([
      { start: 1, end: 3.5, speaker: "Ada", text: "one" },
      { start: 4, end: Number.NaN, speaker: "Ada", text: "two" },
    ]);
    expect(a!.end).toBe(3.5);
    expect(b!.end).toBeNull();
  });

  it("shows a speaker's label but keeps the producer's attribution as the key", () => {
    const lines = toTranscript(
      [
        { start: 0, speaker: "Speaker 1", text: "hi" },
        { start: 2, speaker: "Speaker 2", text: "hello" },
        { start: 4, speaker: "", text: "nobody" },
      ],
      { "Speaker 1": "Ada Lovelace" },
    );
    expect(lines.map((l) => [l.speaker, l.sourceSpeaker])).toEqual([
      ["Ada Lovelace", "Speaker 1"],
      ["Speaker 2", "Speaker 2"],
      ["Unknown speaker", null],
    ]);
  });

  it("never reads a label off the object prototype", () => {
    const [line] = toTranscript([{ start: 0, speaker: "constructor", text: "x" }], {});
    expect(line!.speaker).toBe("constructor");
  });
});

describe("distinctSpeakers", () => {
  it("lists each producer speaker once, in order of first appearance, skipping unattributed lines", () => {
    const lines = toTranscript([
      { speaker: "B", text: "1" },
      { speaker: "A", text: "2" },
      { speaker: "", text: "3" },
      { speaker: "B", text: "4" },
    ]);
    expect(distinctSpeakers(lines)).toEqual(["B", "A"]);
  });
});

describe("activeSegmentIndex", () => {
  const line = (at: number | null, speaker: string, text: string): TranscriptLine =>
    ({ at, end: null, speaker, sourceSpeaker: speaker, text });
  const lines: TranscriptLine[] = [line(0, "Ada", "one"), line(8.5, "Bea", "two"), line(21, "Ada", "three")];

  it("is null before anything has played, or before lines have loaded", () => {
    expect(activeSegmentIndex(lines, null)).toBeNull();
    expect(activeSegmentIndex(null, 5)).toBeNull();
  });

  it("picks the LATEST segment at or before currentTime, never the nearest", () => {
    expect(activeSegmentIndex(lines, 0)).toBe(0);
    expect(activeSegmentIndex(lines, 8.4)).toBe(0); // just before the second segment starts
    expect(activeSegmentIndex(lines, 8.5)).toBe(1); // exactly at its start
    expect(activeSegmentIndex(lines, 15)).toBe(1); // between two and three: still "two"
  });

  it("stays on the last segment once playback runs past it", () => {
    expect(activeSegmentIndex(lines, 999)).toBe(2);
  });

  it("skips a segment with no offset rather than treating it as always-current", () => {
    const withGap: TranscriptLine[] = [line(null, "Ada", "no offset"), line(10, "Bea", "has one")];
    expect(activeSegmentIndex(withGap, 0)).toBeNull();
    expect(activeSegmentIndex(withGap, 10)).toBe(1);
  });
});

describe("formatClock", () => {
  it("renders mm:ss, and h:mm:ss past an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(null)).toBe("");
    expect(formatClock(-1)).toBe("");
  });
});

describe("transcriptToText", () => {
  it("emits exactly what the page shows", () => {
    const text = transcriptToText("Sync", [
      { at: 65, end: null, speaker: "Ada", sourceSpeaker: "Speaker 1", text: "Hi" },
    ]);
    expect(text).toContain("[1:05] Ada: Hi");
    expect(text.startsWith("Sync\n====\n")).toBe(true);
  });
});

describe("initialsOf", () => {
  it("takes the first and last word, at most two letters", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Ada")).toBe("A");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("mergeMeetingsPage (pagination + polling)", () => {
  const m = (id: string, over: Partial<Meeting> = {}): Meeting =>
    toMeeting({ id, platform: "google_meet", native_meeting_id: id, status: "completed", ...over } as MeetingRowDTO);

  it("append: adds new rows after what is already loaded, de-duplicating by id", () => {
    const loaded = [m("1"), m("2")];
    const page = [m("2"), m("3")]; // "2" repeats — a race between two requests
    const merged = mergeMeetingsPage(loaded, page, "append");
    expect(merged.map((x) => x.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("append: an empty page changes nothing", () => {
    const loaded = [m("1"), m("2")];
    expect(mergeMeetingsPage(loaded, [], "append").map((x) => x.id).sort()).toEqual(["1", "2"]);
  });

  it("replace: a live row loaded via a second page stays visible after the poll re-fetches the WHOLE window", () => {
    const loaded = [m("1", { status: "completed" }), m("2", { status: "active" })]; // "2" is live, loaded via page 2
    // The poll re-fetched offset 0, limit=2 — the full loaded window — and "2" is still in it.
    const freshWindow = [m("1", { status: "completed" }), m("2", { status: "active" })];
    const merged = mergeMeetingsPage(loaded, freshWindow, "replace");
    expect(merged.some((x) => x.id === "2" && x.phase === "live")).toBe(true);
  });

  it("replace: a row missing from the fresh window is dropped, not carried over from the stale poll", () => {
    const loaded = [m("1"), m("2")];
    const freshWindow = [m("1")]; // "2" was deleted between polls
    const merged = mergeMeetingsPage(loaded, freshWindow, "replace");
    expect(merged.map((x) => x.id)).toEqual(["1"]);
  });

  it("replace: live rows sort first regardless of the fresh page's own order", () => {
    const freshWindow = [m("1", { status: "completed" }), m("2", { status: "active" })];
    const merged = mergeMeetingsPage([], freshWindow, "replace");
    expect(merged[0]!.id).toBe("2");
  });
});

describe("sortMeetingsBy", () => {
  const m = (id: string, over: Partial<MeetingRowDTO> = {}) => toMeeting(row({ id, ...over }));
  const list = [
    m("a", { start_time: "2026-09-10T10:00:00Z", end_time: "2026-09-10T10:30:00Z", data: { title: "beta" } }),
    m("b", { start_time: "2026-09-12T10:00:00Z", end_time: "2026-09-12T10:05:00Z", data: { title: "Alpha" } }),
    m("c", { start_time: null, end_time: null, data: { title: "gamma" } }),
    m("live", { status: "active", start_time: "2026-09-01T10:00:00Z", data: { title: "zeta" } }),
  ];

  it("keeps the live meeting on top under every order", () => {
    for (const by of ["newest", "oldest", "longest", "title"] as const) {
      expect(sortMeetingsBy(list, by)[0]!.id).toBe("live");
    }
  });

  it("orders by time either way, a row with no time going last", () => {
    expect(sortMeetingsBy(list, "oldest").map((x) => x.id)).toEqual(["live", "a", "b", "c"]);
    expect(sortMeetingsBy(list, "newest").map((x) => x.id)).toEqual(["live", "b", "a", "c"]);
  });

  it("orders by duration, unknown last, and by title case-insensitively", () => {
    expect(sortMeetingsBy(list, "longest").map((x) => x.id)).toEqual(["live", "a", "b", "c"]);
    expect(sortMeetingsBy(list, "title").map((x) => x.title)).toEqual(["zeta", "Alpha", "beta", "gamma"]);
  });

  it("never mutates its input", () => {
    const before = list.map((x) => x.id);
    sortMeetingsBy(list, "title");
    expect(list.map((x) => x.id)).toEqual(before);
  });
});

describe("loadedTags", () => {
  it("is the alphabetical union of the loaded rows' tags", () => {
    const a = toMeeting(row({ id: 1, data: { metadata: { tags: ["sales", "q3"] } } }));
    const b = toMeeting(row({ id: 2, data: { metadata: { tags: ["q3", "acme"] } } }));
    expect(loadedTags([a, b])).toEqual(["acme", "q3", "sales"]);
  });
});

describe("filterMeetings — tags", () => {
  it("matches a tag as well as a title", () => {
    const tagged = toMeeting(row({ id: 9, data: { title: "Call", metadata: { tags: ["acme renewal"] } } }));
    expect(filterMeetings([tagged], "renewal").map((x) => x.id)).toEqual(["9"]);
  });
});
