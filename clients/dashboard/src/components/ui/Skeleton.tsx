"use client";
/** A loading placeholder shaped like the content it stands in for. Decorative only — pair it with
 *  a `role="status"` announcement somewhere in the same view (see `EmptyState.tsx`'s
 *  `LoadingState`) rather than relying on the pulse to communicate anything to a screen reader. */
import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("animate-pulse rounded-md bg-raised", className)} />;
}
