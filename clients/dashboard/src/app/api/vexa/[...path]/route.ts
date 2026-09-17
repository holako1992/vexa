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
 *   • Only GET, and only the three read paths the product has. An unmatched path is 404 here, not
 *     a forwarded probe of the gateway.
 */
import type { NextRequest } from "next/server";
import { resolveUpstream, filterQuery } from "@/lib/upstream";
import { sessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:18056").replace(/\/$/, "");
const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE });

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const route = resolveUpstream(path);
  if (!route) return json({ error: "not_found" }, 404);

  const token = await sessionToken();
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
    // Fail loud: a real error body and a 502, never a silent {} that reads as "no data".
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return json({ error: "upstream_unreachable", detail }, 502);
  }

  if (upstream.status === 204 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  }
  // Pass the upstream status through with its body. The body is re-serialised as JSON and no
  // upstream header is copied — a backend must not be able to set a header on this origin.
  return new Response(await upstream.text(), { status: upstream.status, headers: NO_STORE });
}
