/** The header pass-through, weighted the same way `upstream.test.ts` is: what gets forwarded,
 *  and — the part that matters for a proxy that must never leak more than it means to — what
 *  does not. */
import { describe, expect, it } from "vitest";
import { rawRequestHeaders, rawResponseHeaders } from "../rawStream";

describe("rawRequestHeaders", () => {
  it("forwards a Range header verbatim", () => {
    expect(rawRequestHeaders("bytes=0-1023")).toEqual({ Range: "bytes=0-1023" });
    expect(rawRequestHeaders("bytes=1000-")).toEqual({ Range: "bytes=1000-" });
  });

  it("adds nothing when the caller sent no Range", () => {
    expect(rawRequestHeaders(null)).toEqual({});
    expect(rawRequestHeaders(undefined)).toEqual({});
    expect(rawRequestHeaders("")).toEqual({});
  });
});

describe("rawResponseHeaders", () => {
  it("copies content-type/content-length/content-range/accept-ranges and adds Cache-Control: no-store", () => {
    const upstream = new Headers({
      "content-type": "audio/wav",
      "content-length": "512",
      "content-range": "bytes 0-511/2048",
      "accept-ranges": "bytes",
    });
    expect(rawResponseHeaders(upstream)).toEqual({
      "content-type": "audio/wav",
      "content-length": "512",
      "content-range": "bytes 0-511/2048",
      "accept-ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("omits a header the upstream didn't send, rather than inventing one", () => {
    // A full (non-Range) 200 has no Content-Range — the object must not carry a stale/empty one.
    const upstream = new Headers({ "content-type": "audio/webm", "content-length": "4096" });
    const out = rawResponseHeaders(upstream);
    expect(out).toEqual({
      "content-type": "audio/webm",
      "content-length": "4096",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    expect("content-range" in out).toBe(false);
    expect("accept-ranges" in out).toBe(false);
  });

  it("never copies a header outside the fixed allowlist (e.g. Set-Cookie, a trace header)", () => {
    const upstream = new Headers({
      "content-type": "audio/wav",
      "set-cookie": "session=leaked",
      "x-trace-id": "abc123",
    });
    const out = rawResponseHeaders(upstream);
    expect(out["set-cookie"]).toBeUndefined();
    expect(out["x-trace-id"]).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(["Cache-Control", "X-Content-Type-Options", "content-type"].sort());
  });

  it("serves a non-media upstream type as an opaque download, never as a document", () => {
    for (const t of ["text/html", "text/html; charset=utf-8", "application/javascript", "image/svg+xml"]) {
      expect(rawResponseHeaders(new Headers({ "content-type": t }))["content-type"]).toBe("application/octet-stream");
    }
    expect(rawResponseHeaders(new Headers({ "content-type": "audio/webm;codecs=opus" }))["content-type"]).toBe("audio/webm;codecs=opus");
    expect(rawResponseHeaders(new Headers({ "content-type": "video/mp4" }))["content-type"]).toBe("video/mp4");
  });
});
