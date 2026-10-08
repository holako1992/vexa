/** The plain-words notice for a meeting allowance that will not (or did not) admit a bot.
 *
 *  Shared by every surface that dispatches a bot from a pasted link — the Add Bot dialog and the
 *  first-run welcome — so a refused send reads the same everywhere. Dependency-free apart from
 *  `entitlements.ts`, whose formatters it composes.
 */
import {
  formatResetDate,
  reasonMessage,
  type Entitlements,
  type QuotaExceededBody,
} from "./entitlements";

/** What a surface shows for a refused send: what happened, when the allowance resets, and — when
 *  there is somewhere to go — a link to the producer's own `upgrade_url`, else to the dashboard's
 *  billing page. */
export interface QuotaNotice {
  ok: false;
  msg: string;
  link?: { href: string; label: string };
}

export function quotaNoticeFrom(body: QuotaExceededBody): QuotaNotice {
  // A stated reason replaces the generic "allowance spent" wording: an unverified account has not
  // spent anything, and the way out is not a plan link.
  const why = reasonMessage(body.reason);
  if (why) return { ok: false, msg: why };
  const reset = formatResetDate(body.resets_at);
  const limitPart = body.limit != null ? ` your ${body.limit} meeting${body.limit === 1 ? "" : "s"}` : " your meeting allowance";
  const msg = `You've used${limitPart} for this billing period.${reset ? ` ${reset}.` : ""}`;
  return body.upgrade_url
    ? { ok: false, msg, link: { href: body.upgrade_url, label: "Upgrade" } }
    : { ok: false, msg, link: { href: "/billing", label: "See billing" } };
}

/** Whether the resolved allowance already says a send will be refused: a stated reason (an
 *  unverified address has none to spend), or a metered limit that is used up. Unknown usage and an
 *  unlimited plan are not "spent". This is a hint for what to show up front — the server remains
 *  the authority on whether a send is admitted, so a caller must never disable sending on it. */
export function isAllowanceSpent(
  e: Pick<Entitlements, "limits" | "usage"> & { reason?: string | null },
): boolean {
  if (reasonMessage(e.reason)) return true;
  const limit = e.limits.meetings_per_month;
  const used = e.usage.meetings_used;
  return limit != null && used != null && used >= limit;
}
