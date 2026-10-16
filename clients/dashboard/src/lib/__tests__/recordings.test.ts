/** `toRecording`'s mapping and the two display formatters, weighted towards the honest-fallback
 *  and null-means-unlimited rules `meetings.ts`/`entitlements.ts` already follow. */
import { describe, expect, it } from "vitest";
import { type RecordingRowDTO, deleteAllRecordings, formatRecordedAt, formatRetention, toRecording } from "../recordings";

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

describe("deleteAllRecordings", () => {
  const row = (id: number): RecordingRowDTO => ({ id, meeting_id: id + 1000 });
  // Two pages that SHRINK as rows are deleted — the reader must collect ids before deleting.
  function server(ids: number[], pageSize = 2) {
    let live = [...ids];
    const deleted: string[] = [];
    return {
      deleted,
      fetchPage: async (offset: number) => {
        const page = live.slice(offset, offset + pageSize);
        return { recordings: page.map(row), has_more: offset + page.length < live.length };
      },
      deleteOne: async (id: string) => {
        deleted.push(id);
        live = live.filter((x) => String(x) !== id);
      },
    };
  }

  it("collects every id across pages first, then deletes each once", async () => {
    const s = server([1, 2, 3, 4, 5]);
    const progress: [number, number][] = [];
    const out = await deleteAllRecordings(s.fetchPage, s.deleteOne, (d, t) => progress.push([d, t]));
    expect(s.deleted).toEqual(["1", "2", "3", "4", "5"]);
    expect(out).toEqual({ deleted: 5, stillRecording: 0, failed: 0 });
    expect(progress.at(0)).toEqual([0, 5]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it("keeps going past a refusal, and counts a still-live meeting apart", async () => {
    const s = server([1, 2, 3]);
    const live = new Error("409");
    const deleteOne = async (id: string) => {
      if (id === "1") throw live;
      if (id === "2") throw new Error("500");
      await s.deleteOne(id);
    };
    const out = await deleteAllRecordings(s.fetchPage, deleteOne, () => {}, (e) => e === live);
    expect(out).toEqual({ deleted: 1, stillRecording: 1, failed: 1 });
    expect(s.deleted).toEqual(["3"]);
  });

  it("does nothing when there is nothing to delete", async () => {
    const s = server([]);
    expect(await deleteAllRecordings(s.fetchPage, s.deleteOne)).toEqual({ deleted: 0, stillRecording: 0, failed: 0 });
  });
});
