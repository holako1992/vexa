"use client";
/** The three states a data surface can be in other than "here is your data": loading, failed,
 *  and genuinely empty. They are separate on purpose — a failure that renders as "no meetings"
 *  is the bug this component exists to make impossible. */
import { AlertCircle, Inbox, Loader2 } from "lucide-react";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-ink-3" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-card border border-line bg-card px-6 py-10 text-center" role="alert">
      <AlertCircle size={22} className="mx-auto mb-3 text-live" aria-hidden />
      <p className="text-sm text-ink">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <Inbox size={22} className="mx-auto mb-3 text-ink-3" aria-hidden />
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-3">{hint}</p>}
    </div>
  );
}
