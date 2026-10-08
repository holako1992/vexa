/** `/api/account` — the signed-in person's own account.
 *
 *  `GET` reads the profile, recorded sign-in door and dashboard sessions. `DELETE` erases the
 *  account immediately and for good. It is a DELETE on the account itself (the sibling
 *  `DELETE /api/account/sessions` is the same shape one level down) and carries a body, the
 *  person's typed email, because the confirmation is part of the request rather than a second
 *  round trip that a script could skip.
 *
 *  In both, the user is the one the identity oracle names for the session cookie; the request has
 *  no way to name another. `DELETE` guards, in order: same-origin write · session · rate limit ·
 *  typed email equals the oracle's email for that session (400 otherwise, before any admin call).
 *  Success (and "already gone") clears the session cookies. A deletion that stays partial after
 *  the bounded retries also clears them — the core has already revoked the account's tokens, so
 *  the cookie is dead — and answers 502 `partial`; a deletion the core refuses (409) or cannot
 *  reach leaves the browser signed in and the account untouched. Producer text is never relayed. */
import { NextResponse, type NextRequest } from "next/server";
import { deleteAccount, loadAccount, resolveAccountCaller } from "@/lib/accountApi";
import { DELETE_FAILURE_TEXT, emailMatches } from "@/lib/account";
import { clearSessionCookies } from "@/lib/session";
import { isSameOriginWrite } from "@/lib/security";
import { hit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

/** 3 per 10 minutes per account: a typo and a retry, not a probe. */
const DELETE_LIMIT = 3;
const WINDOW_MS = 10 * 60 * 1000;

export async function GET() {
  const caller = await resolveAccountCaller();
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: NO_STORE });
  const loaded = await loadAccount(caller.userId);
  if (!loaded.ok) {
    console.error(`[dashboard-account] read failed for user ${caller.userId}: ${loaded.error}`);
    return NextResponse.json({ error: "Could not read your account right now." }, { status: loaded.status, headers: NO_STORE });
  }
  return NextResponse.json(loaded.account, { headers: NO_STORE });
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginWrite(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403, headers: NO_STORE });
  }
  const caller = await resolveAccountCaller();
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: NO_STORE });

  const limited = hit(`account-delete:${caller.userId}:${caller.email.toLowerCase()}`, DELETE_LIMIT, WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  let typed: unknown;
  try {
    typed = ((await request.json()) as { confirmEmail?: unknown } | null)?.confirmEmail;
  } catch {
    typed = undefined;
  }
  if (!emailMatches(typed, caller.email)) {
    return NextResponse.json({ error: "Type your account's email address to confirm." }, { status: 400, headers: NO_STORE });
  }

  const outcome = await deleteAccount(caller.userId);
  if (outcome === "deleted") {
    await clearSessionCookies();
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  }
  console.error(`[dashboard-account] delete of user ${caller.userId} ended ${outcome}`);
  if (outcome === "partial") {
    await clearSessionCookies();
    return NextResponse.json({ error: DELETE_FAILURE_TEXT.partial, outcome }, { status: 502, headers: NO_STORE });
  }
  return NextResponse.json(
    { error: DELETE_FAILURE_TEXT[outcome], outcome },
    { status: outcome === "blocked" ? 409 : 503, headers: NO_STORE },
  );
}
