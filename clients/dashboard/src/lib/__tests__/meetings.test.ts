/** The row mapper and the transcript mapper — presentation decisions only, so the test pins the
 *  honest fallbacks and the ordering rather than any reshaping (there is none to pin). */
import { describe, expect, it } from "vitest";
import {
  type Meeting,
  type MeetingRowDTO,
  filterMeetings,
  formatClock,
  initialsOf,
  mergeMeetingsPage,
  pageMayContinue,
  sortMeetings,
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
      { at: 0, speaker: "Ada", text: "Hello" },
      { at: 4, speaker: "Unknown speaker", text: "second" },
    ]);
  });

  it("survives a missing or malformed segments field", () => {
    expect(toTranscript(undefined)).toEqual([]);
    expect(toTranscript(null)).toEqual([]);
    expect(toTranscript([{ text: "no offset" }])).toEqual([{ at: null, speaker: "Unknown speaker", text: "no offset" }]);
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
    const text = transcriptToText("Sync", [{ at: 65, speaker: "Ada", text: "Hi" }]);
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

describe("pageMayContinue (DB-48)", () => {
  it("a full page (as long as the requested limit) means more may exist", () => {
    expect(pageMayContinue(20, 20)).toBe(true);
  });

  it("a short page means this was the last one", () => {
    expect(pageMayContinue(3, 20)).toBe(false);
  });

  it("an empty page never continues, even if limit is 0-ish or odd", () => {
    expect(pageMayContinue(0, 20)).toBe(false);
  });

  it("a page longer than the limit (should not happen, but must not hide a real gap) still continues", () => {
    expect(pageMayContinue(25, 20)).toBe(true);
  });
});

describe("mergeMeetingsPage (DB-48 pagination + polling)", () => {
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
