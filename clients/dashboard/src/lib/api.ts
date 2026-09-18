"use client";
/** The browser-side fetch helper. One chokepoint, and it fails LOUD.
 *
 *  A non-ok response or a network failure throws `ApiError` carrying the status, so a surface
 *  renders "the server refused / is unreachable" instead of an empty list that looks like "you
 *  have no meetings". A 200 with an empty body is not an error — an empty result is a result.
 */

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string, url: string) {
    super(`${url} → ${status || "network"}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiError";
  }
}

/** The sentence a surface shows, in the reader's vocabulary. */
export function presentError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "Couldn't reach the dashboard server — check that it is running.";
    if (e.status === 401) return "Your session expired. Sign in again.";
    if (e.status === 403) return "Your account doesn't have access to this.";
    if (e.status === 404) return "Not found.";
    if (e.status === 429) return "Too many requests — try again in a moment.";
    if (e.status === 502 || e.status === 503 || e.status === 504) return "The Vexa backend is unreachable right now.";
    return `The request failed (${e.status}).`;
  }
  return "Something went wrong — details are in the browser console.";
}

export async function mutateJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  const init: RequestInit = {
    method,
    cache: "no-store",
    headers: body != null ? { "Content-Type": "application/json" } : {},
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  };
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error", url);
  }
  if (!r.ok) {
    let detail = "";
    try {
      const b = (await r.json()) as { detail?: unknown; error?: unknown };
      const d = b?.detail ?? b?.error;
      detail = typeof d === "string" ? d : d != null ? JSON.stringify(d).slice(0, 200) : "";
    } catch { /* not JSON */ }
    throw new ApiError(r.status, detail, url);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { cache: "no-store", ...init });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error", url);
  }
  if (!r.ok) {
    let detail = "";
    try {
      const body = (await r.json()) as { detail?: unknown; error?: unknown };
      const d = body?.detail ?? body?.error;
      detail = typeof d === "string" ? d : d != null ? JSON.stringify(d).slice(0, 200) : "";
    } catch {
      /* not JSON — the status is the whole signal */
    }
    throw new ApiError(r.status, detail, url);
  }
  return (await r.json()) as T;
}
