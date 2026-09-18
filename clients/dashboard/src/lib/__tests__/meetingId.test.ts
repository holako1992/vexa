/** `parseMeetingInput` is the only thing standing between a pasted URL and the payload the
 *  dashboard sends to `POST /bots` — wrong platform or id means the bot dispatches to the wrong
 *  meeting (or none). Tested against real-shaped URLs for each platform, plus what it must
 *  refuse. */
import { describe, expect, it } from "vitest";
import { parseMeetingInput } from "../meetingId";

describe("parseMeetingInput — Google Meet", () => {
  it("parses a meet.google.com URL", () => {
    expect(parseMeetingInput("https://meet.google.com/abc-defg-hij")).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
    });
  });

  it("parses a bare meeting code with no URL at all", () => {
    expect(parseMeetingInput("abc-defg-hij")).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
    });
  });

  it("lowercases a mixed-case code and URL", () => {
    expect(parseMeetingInput("ABC-DEFG-HIJ")).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
    });
    expect(parseMeetingInput("https://meet.google.com/ABC-DEFG-HIJ")).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
    });
  });

  it("refuses a meet.google.com URL whose path isn't a valid code", () => {
    expect(parseMeetingInput("https://meet.google.com/")).toBeNull();
    expect(parseMeetingInput("https://meet.google.com/not-a-code")).toBeNull();
  });
});

describe("parseMeetingInput — Zoom", () => {
  it("parses a /j/<id> join URL", () => {
    expect(parseMeetingInput("https://zoom.us/j/1234567890")).toEqual({
      platform: "zoom",
      native_meeting_id: "1234567890",
    });
  });

  it("parses a /j/<id> URL with a query string and extra path", () => {
    expect(parseMeetingInput("https://us02web.zoom.us/j/1234567890?pwd=abcXYZ")).toEqual({
      platform: "zoom",
      native_meeting_id: "1234567890",
    });
  });

  it("falls back to the query string when the path carries no digits", () => {
    expect(parseMeetingInput("https://zoom.us/w/?confno=987654321")).toEqual({
      platform: "zoom",
      native_meeting_id: "987654321",
    });
  });

  it("refuses a /my/<vanity-name> personal link — no numeric id to extract", () => {
    expect(parseMeetingInput("https://zoom.us/my/jane.doe")).toBeNull();
  });

  it("parses a bare 9-11 digit id with no URL", () => {
    expect(parseMeetingInput("1234567890")).toEqual({ platform: "zoom", native_meeting_id: "1234567890" });
  });

  it("refuses a digit run shorter than 9 or longer than 11 with no URL", () => {
    expect(parseMeetingInput("12345678")).toBeNull();
    expect(parseMeetingInput("123456789012")).toBeNull();
  });
});

describe("parseMeetingInput — Microsoft Teams", () => {
  it("parses a full meetup-join URL carrying an encoded 19:meeting_ thread id", () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_MmZhZTMzM2QtZGRhOS00%40thread.v2/0?context=%7B%7D";
    expect(parseMeetingInput(url)).toEqual({
      platform: "teams",
      native_meeting_id: "19:meeting_MmZhZTMzM2QtZGRhOS00@thread.v2",
    });
  });

  it("parses a short teams.live.com/meet/<id> link", () => {
    expect(parseMeetingInput("https://teams.live.com/meet/9876543210?p=abc")).toEqual({
      platform: "teams",
      native_meeting_id: "9876543210",
    });
  });

  it("refuses a Teams URL with neither shape", () => {
    expect(parseMeetingInput("https://teams.microsoft.com/about")).toBeNull();
  });
});

describe("parseMeetingInput — Jitsi", () => {
  it("parses meet.jit.si with just the room name", () => {
    expect(parseMeetingInput("https://meet.jit.si/MyRoomName")).toEqual({
      platform: "jitsi",
      native_meeting_id: "MyRoomName",
    });
  });

  it("parses a self-hosted host that is in the passed jitsiHosts allowlist", () => {
    expect(parseMeetingInput("https://jitsi.example.com/TeamStandup", ["jitsi.example.com"])).toEqual({
      platform: "jitsi",
      native_meeting_id: "TeamStandup@jitsi.example.com",
    });
  });

  it("refuses a host that looks like nothing jitsi-ish and isn't in jitsiHosts", () => {
    expect(parseMeetingInput("https://calls.example.com/TeamStandup", ["jitsi.example.com"])).toBeNull();
  });

  it("still recognizes a host containing 'jitsi' even when not in the explicit list", () => {
    expect(parseMeetingInput("https://my-jitsi-server.example.com/Room1")).toEqual({
      platform: "jitsi",
      native_meeting_id: "Room1@my-jitsi-server.example.com",
    });
  });

  it("refuses an empty room path on a jitsi host", () => {
    expect(parseMeetingInput("https://meet.jit.si/")).toBeNull();
  });
});

describe("parseMeetingInput — refusals", () => {
  it("returns null for empty or whitespace-only input", () => {
    expect(parseMeetingInput("")).toBeNull();
    expect(parseMeetingInput("   ")).toBeNull();
  });

  it("returns null for a well-formed URL on an unrecognized platform", () => {
    expect(parseMeetingInput("https://example.com/some/page")).toBeNull();
  });

  it("returns null for plain non-URL, non-code text", () => {
    expect(parseMeetingInput("hello there")).toBeNull();
  });
});
