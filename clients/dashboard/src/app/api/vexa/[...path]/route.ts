/** The dashboard's ONE door to the backend.
 *
 *  Every browser call lands here, is matched against a closed allowlist (lib/upstream.ts), and is
 *  forwarded to the gateway with the signed-in user's own API key. Three properties are the point:
 *
 *   • The key never reaches the browser. It lives in the httpOnly `vexa-token` cookie, is read
 *     server-side, and is attached here.
 *   • There is NO env-key fallback. The terminal falls back to VEXA_API_KEY for single-key
 *     self-hosts; the dashboard must not, because it is a multi-user surface — a fallback would
 *     serve one deployment-wide identity's meetings to whoever happened to be at the keyboard.
 *     No cookie means 401.
 *   • Read paths are GET-only. Write paths (bots, user/calendars) are explicitly listed in the
 *     write allowlist and never overlap with the read allowlist.
 */
import type { NextRequest } from "next/server";
import { resolveUpstream, resolveWriteUpstream, filterQuery } from "@/lib/upstream";
import { sessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE });

async function gatewayKey(): Promise<string | undefined> {
  return sessionToken();
}

function passThrough(upstream: Response): Response {
  if (upstream.status === 204 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(upstream.body, { status: upstream.status, headers: NO_STORE });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const route = resolveUpstream(path);
  if (!route) return json({ error: "not_found" }, 404);

  const token = await gatewayKey();
  if (!token) return json({ error: "not_authenticated" }, 401);

  const url = `${GATEWAY_URL}${route.path}${filterQuery(req.nextUrl.searchParams)}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": token, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return json({ error: "upstream_unreachable", detail }, 502);
  }
  return passThrough(upstream);
}

async function forwardWrite(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: string): Promise<Response> {
  const { path } = await ctx.params;
  const route = resolveWriteUpstream(method, path);
  if (!route) return json({ error: "not_found" }, 404);

  const token = await gatewayKey();
  if (!token) return json({ error: "not_authenticated" }, 401);

  const url = `${GATEWAY_URL}${route.path}`;
  const body = method !== "DELETE" ? await req.text() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: {
        "X-API-Key": token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return json({ error: "upstream_unreachable", detail }, 502);
  }
  return passThrough(upstream);
}

export function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forwardWrite(req, ctx, "POST");
}

export function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forwardWrite(req, ctx, "PATCH");
}

export function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forwardWrite(req, ctx, "DELETE");
}
