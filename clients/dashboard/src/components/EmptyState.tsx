"use client";
/** The three states a data surface can be in other than "here is your data": loading, failed,
 *  and genuinely empty. They are separate on purpose — a failure that renders as "no meetings"
 *  is the bug this component exists to make impossible.
 *
 *  An empty state names the next action: `action` is the control that takes it (a `Button` or a
 *  link), rendered under the hint. A failure offers `onRetry` wherever asking again can help. */
import type { ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";
import { Button, Skeleton } from "./ui";

/** `label` is the accessible announcement (visually hidden) — the visible placeholder is a
 *  `Skeleton`, which communicates nothing to a screen reader on its own. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="px-4 py-8 md:px-8" role="status">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-2/3" />
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-card border border-line bg-card px-6 py-10 text-center" role="alert">
      <AlertCircle size={22} className="mx-auto mb-3 text-live" aria-hidden />
      <p className="text-sm text-ink">{message}</p>
      {onRetry && (
        <Button variant="primary" onClick={onRetry} className="mt-4">
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <Inbox size={22} className="mx-auto mb-3 text-ink-3" aria-hidden />
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-3">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** The look of a secondary `Button`, for a next action that is a navigation and so must be a
 *  real link (`next/link`), not a `<button>`. */
export const LINK_BUTTON_CLASS =
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-ink-2 transition-colors hover:bg-raised";
