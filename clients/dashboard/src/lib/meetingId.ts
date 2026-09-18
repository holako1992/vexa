/** Meeting-link → {platform, native_meeting_id} parsing for the "Send Bot" flow.
 *  Mirrors clients/terminal/src/surfaces/meetingId.ts — keep in sync. */

export type Platform = "google_meet" | "teams" | "zoom" | "jitsi";

export interface ParsedMeeting {
  platform: Platform;
  native_meeting_id: string;
}

const GMEET_ID = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ZOOM_ID = /\d{9,11}/;
const JITSI_ROOM = /^[^/?#\s]+$/;

export function isValidMeetingId(platform: Platform, id: string): boolean {
  const v = id.trim();
  if (!v) return false;
  if (platform === "google_meet") return GMEET_ID.test(v.toLowerCase());
  if (platform === "zoom") return /^\d{9,11}$/.test(v);
  if (platform === "jitsi") return JITSI_ROOM.test(v);
  return v.length > 0;
}

export function parseMeetingInput(raw: string, jitsiHosts: readonly string[] = []): ParsedMeeting | null {
  const input = raw.trim();
  if (!input) return null;

  if (GMEET_ID.test(input.toLowerCase())) {
    return { platform: "google_meet", native_meeting_id: input.toLowerCase() };
  }

  let url: URL | null = null;
  try { url = new URL(input); } catch { url = null; }

  if (url) {
    const host = url.hostname.toLowerCase();
    if (host.includes("meet.google.com")) {
      const code = url.pathname.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
      return isValidMeetingId("google_meet", code) ? { platform: "google_meet", native_meeting_id: code } : null;
    }
    if (host.includes("zoom")) {
      const m = url.pathname.match(ZOOM_ID) || url.search.match(ZOOM_ID);
      return m ? { platform: "zoom", native_meeting_id: m[0] } : null;
    }
    if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) {
      const decoded = decodeURIComponent(input);
      const thread = decoded.match(/19:meeting_[^@%\s/]+@thread\.v2/i);
      if (thread) return { platform: "teams", native_meeting_id: thread[0] };
      const short = url.pathname.match(/\/meet\/([^/?#]+)/i);
      if (short) return { platform: "teams", native_meeting_id: short[1] };
      return null;
    }
    const jitsiHost =
      host === "meet.jit.si" || jitsiHosts.includes(host) ||
      host.includes("jitsi") || host.split(".").includes("meet");
    if (jitsiHost) {
      const room = url.pathname.replace(/^\/+|\/+$/g, "");
      if (!room || !JITSI_ROOM.test(room)) return null;
      return { platform: "jitsi", native_meeting_id: host === "meet.jit.si" ? room : `${room}@${host}` };
    }
    return null;
  }

  if (/^\d{9,11}$/.test(input)) return { platform: "zoom", native_meeting_id: input };
  return null;
}
