/** `toRecording`'s mapping and the two display formatters, weighted towards the honest-fallback
 *  and null-means-unlimited rules `meetings.ts`/`entitlements.ts` already follow. */
import { describe, expect, it } from "vitest";
import { type RecordingRowDTO, formatRecordedAt, formatRetention, toRecording } from "../recordings";

describe("toRecording", () => {
  it("maps the list row's own fields and finds the audio media file", () => {
    const row: RecordingRowDTO = {
      id: 555001,
      meeting_id: 102,
      status: "completed",
      created_at: "2026-09-15T14:00:00Z",
      completed_at: "2026-09-15T14:42:00Z",
      deletion_pending: false,
      duration_seconds: 2520,
      media_files: [
        { id: 9001, type: "video", format: "webm" },
        { id: 9002, type: "audio", format: "wav" },
      ],
    };
    expect(toRecording(row)).toEqual({
      id: "555001",
      meetingId: "102",
      status: "completed",
      createdAt: "2026-09-15T14:00:00Z",
      completedAt: "2026-09-15T14:42:00Z",
      durationSeconds: 2520,
      deletionPending: false,
      audioMediaFileId: "9002",
    });
  });

  it("is null on audioMediaFileId when there is no audio track yet", () => {
    expect(toRecording({ id: 1, meeting_id: 2, media_files: [{ id: 3, type: "video" }] }).audioMediaFileId).toBeNull();
    expect(toRecording({ id: 1, meeting_id: 2 }).audioMediaFileId).toBeNull();
    expect(toRecording({ id: 1, meeting_id: 2, media_files: [] }).audioMediaFileId).toBeNull();
  });

  it("falls back to an honest status and drops an out-of-range duration", () => {
    expect(toRecording({ id: 1, meeting_id: 2 }).status).toBe("unknown");
    expect(toRecording({ id: 1, meeting_id: 2, duration_seconds: Number.NaN }).durationSeconds).toBeNull();
    expect(toRecording({ id: 1, meeting_id: 2, duration_seconds: "60" as unknown as number }).durationSeconds).toBeNull();
  });
});

describe("formatRecordedAt", () => {
  it("formats a real timestamp and falls back honestly otherwise", () => {
    expect(formatRecordedAt(null)).toBe("Unknown date");
    expect(formatRecordedAt("not a date")).toBe("Unknown date");
    expect(formatRecordedAt("2026-09-15T14:00:00Z")).not.toBe("Unknown date");
  });
});

describe("formatRetention", () => {
  it("null means unlimited, never a number to compare against", () => {
    expect(formatRetention(null)).toBe("Kept indefinitely");
  });

  it("renders days, whole months, and the one-year case distinctly", () => {
    expect(formatRetention(7)).toBe("Kept for 7 days");
    expect(formatRetention(1)).toBe("Kept for 1 day");
    expect(formatRetention(60)).toBe("Kept for 2 months");
    expect(formatRetention(30)).toBe("Kept for 1 month");
    expect(formatRetention(365)).toBe("Kept for 1 year");
  });
});
