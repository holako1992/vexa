"use client";
/** DB-74's read-only half: `/billing` — plan, usage meters, reset date, and any past-due /
 *  cancel-at-period-end state, read from `GET /api/vexa/user/entitlements`.
 *
 *  No checkout or portal controls here — DB-73's Stripe endpoint contract on core is not final,
 *  so this view leaves a labelled, empty slot rather than building buttons against an API that
 *  could still change shape (a later task fills it once `billing/checkout` and `billing/portal`
 *  land on the allowlist).
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CreditCard } from "lucide-react";
import { getJson, presentError } from "@/lib/api";
import { formatDayMonth, formatMeetingsUsage, formatMinutesUsage, planStatusLabel, type Entitlements } from "@/lib/entitlements";
import { ErrorState, LoadingState } from "./EmptyState";

const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

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
  const [state, setState] = useState<ViewState>({ kind: "loading" });

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

        {/* Upgrade / manage-billing controls land here once core's Stripe endpoint contract
            (DB-73: billing/checkout, billing/portal) is final. Deliberately empty — not a
            "coming soon" placeholder, just a structured slot a later task fills. */}
        <div aria-hidden="true" className="mt-5 border-t border-line pt-4" />
      </section>
    </div>
  );
}
