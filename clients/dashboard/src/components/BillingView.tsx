"use client";
/** `/billing`: plan, usage meters, reset date, and any past-due / cancel-at-period-end state,
 *  read from `GET /api/vexa/user/entitlements` (DB-74) — plus the two write controls DB-74b adds:
 *
 *   - **Upgrade** on a plan card → `POST /billing/checkout {plan, interval}` → redirect to the
 *     returned Stripe Checkout URL.
 *   - **Manage subscription** → `POST /billing/portal` → redirect to the returned Stripe Customer
 *     Portal URL, or (409, no Stripe customer yet) a toast explaining there's nothing to manage
 *     yet, with a link to Upgrade instead of a generic error.
 *
 *  Both responses are `{url}` straight from Stripe (see `core/identity/services/admin-api/src/
 *  admin_api/app/billing/stripe_gateway.py`) — `isTrustedBillingRedirect` (`lib/security.ts`)
 *  checks it is `https://` and a real Stripe host before this ever calls
 *  `window.location.assign()`, so a malformed or wrong-shaped response fails closed instead of
 *  taking the browser to an arbitrary origin.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CreditCard } from "lucide-react";
import { getJson, mutateJson, presentError, ApiError } from "@/lib/api";
import { formatDayMonth, formatMeetingsUsage, formatMinutesUsage, planStatusLabel, type Entitlements } from "@/lib/entitlements";
import { isTrustedBillingRedirect } from "@/lib/security";
import { Button, Tab, Tabs, useToast } from "./ui";
import { ErrorState, LoadingState } from "./EmptyState";

const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

type Interval = "month" | "year";

/** The paid plans a card can offer to upgrade TO. Prices are never shown here — Stripe's own
 *  Checkout page is the one place a price is ever displayed, so this never risks inventing or
 *  staling one (AGENTS.md: never invent prices beyond `billing/catalog.py`, which this client has
 *  no read access to anyway). */
// Neither blurb below uses the word "unlimited" — the usage meters above already render that
// exact word for a plan with no ceiling (`formatMeetingsUsage`), and `getByText` matches
// case-insensitive substrings, so repeating it here would make that meter's own assertion
// ambiguous between two elements on the page (found the hard way, via 14-billing-paywall.spec.ts's
// "pro plan is unlimited, regardless of usage").
const UPGRADE_PLANS: { id: "pro" | "team"; label: string; blurb: string }[] = [
  { id: "pro", label: "Pro", blurb: "No monthly meeting cap, longer recordings, and AI summaries on every meeting." },
  { id: "team", label: "Team", blurb: "Everything in Pro, plus more concurrent bots and permanent recording retention." },
];

/** Where a checkout/portal `{url}` response failed `isTrustedBillingRedirect` — always a bug or a
 *  misconfigured deployment, never something the person did, hence one shared message. */
const UNTRUSTED_REDIRECT_MESSAGE = "Billing returned an unexpected link. Please try again, or contact support.";

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: Entitlements };

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[15px] text-ink-2">{value}</dd>
    </div>
  );
}

export function BillingView() {
  const toast = useToast();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [billingInterval, setBillingInterval] = useState<Interval>("month");
  // Which single control is in flight, if any — "portal" or a plan id ("pro"/"team"). Only one
  // redirect can be in progress at a time, and every button on the page disables while it is.
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<Entitlements>("/api/vexa/user/entitlements")
      .then((data) => {
        if (!cancelled) setState({ kind: "loaded", data });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: presentError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Billing</h1>
        <LoadingState label="Loading your plan…" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Billing</h1>
        <ErrorState message={state.message} />
      </div>
    );
  }

  const { data } = state;
  const planLabel = PLAN_LABELS[data.plan_id] ?? data.plan_id;
  const meetingsLine = formatMeetingsUsage(data.limits, data.usage);
  const minutesLine = formatMinutesUsage(data.usage);
  const resetDay = formatDayMonth(data.period.end);
  const statusNote = planStatusLabel(data);

  function redirectTo(url: string): boolean {
    if (!isTrustedBillingRedirect(url)) {
      toast.push({ tone: "error", title: "Couldn't open billing", description: UNTRUSTED_REDIRECT_MESSAGE });
      return false;
    }
    window.location.assign(url);
    return true;
  }

  async function upgrade(plan: "pro" | "team") {
    setPending(plan);
    try {
      const { url } = await mutateJson<{ url: string }>("POST", "/api/vexa/billing/checkout", {
        plan,
        interval: billingInterval,
      });
      if (!redirectTo(url)) setPending(null);
      // On success the page is about to navigate away — leave `pending` set so the button stays
      // disabled for the (brief) remainder of this page's life rather than flashing re-enabled.
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't start checkout", description: presentError(e) });
      setPending(null);
    }
  }

  async function manage() {
    setPending("portal");
    try {
      const { url } = await mutateJson<{ url: string }>("POST", "/api/vexa/billing/portal");
      if (!redirectTo(url)) setPending(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.push({
          tone: "info",
          title: "No subscription to manage yet",
          description: "You haven't subscribed to a paid plan — upgrade first to get a billing portal.",
          duration: 0,
        });
      } else {
        toast.push({ tone: "error", title: "Couldn't open the billing portal", description: presentError(e) });
      }
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Billing</h1>
      <p className="mb-6 text-sm text-ink-3">Your plan, usage, and billing period.</p>

      <section aria-label="Plan" className="rounded-card border border-line bg-card p-5">
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-accent" aria-hidden />
          <h2 className="text-sm font-semibold">{planLabel} plan</h2>
        </div>

        {statusNote && (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-warn">
            <AlertTriangle size={13} aria-hidden />
            {statusNote}
          </p>
        )}

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Meter label="Meetings this period" value={meetingsLine} />
          <Meter label="Minutes this period" value={minutesLine} />
          <Meter label="Billing period" value={resetDay ? `Resets ${resetDay}` : "Unknown"} />
          <Meter
            label="Meeting length cap"
            value={data.limits.max_minutes_per_meeting == null ? "Unlimited" : `${data.limits.max_minutes_per_meeting} min`}
          />
        </dl>

        <div className="mt-5 flex justify-end border-t border-line pt-4">
          <Button
            variant="secondary"
            onClick={() => void manage()}
            loading={pending === "portal"}
            disabled={pending !== null && pending !== "portal"}
          >
            Manage subscription
          </Button>
        </div>
      </section>

      <section aria-label="Plans" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Upgrade your plan</h2>
          <Tabs value={billingInterval} onChange={(v) => setBillingInterval(v as Interval)} label="Billing interval">
            <Tab value="month">Monthly</Tab>
            <Tab value="year">Yearly</Tab>
          </Tabs>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {UPGRADE_PLANS.map((plan) => {
            const isCurrent = data.plan_id === plan.id;
            return (
              <div key={plan.id} className="flex flex-col rounded-card border border-line bg-card p-5">
                <h3 className="text-sm font-semibold">{plan.label}</h3>
                <p className="mt-1 flex-1 text-sm text-ink-3">{plan.blurb}</p>
                <Button
                  className="mt-4"
                  onClick={() => void upgrade(plan.id)}
                  loading={pending === plan.id}
                  disabled={isCurrent || (pending !== null && pending !== plan.id)}
                >
                  {isCurrent ? "Current plan" : "Upgrade"}
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
