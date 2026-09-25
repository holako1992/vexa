"use client";
/** A real switch: `role="switch"`, `aria-checked`, and native button semantics so Space/Enter and
 *  a pointer click both work with no extra keydown handler. Replaces every hand-rolled
 *  `<span role="checkbox">` fake toggle in this tree — a checkbox and a switch are different
 *  controls with different expected behaviour, and screen readers announce them differently. */
import clsx from "clsx";
import type { ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Visible label rendered beside the switch. Omit and pass `aria-label` instead when the label
   *  lives elsewhere in the DOM. */
  label?: ReactNode;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function Toggle({ checked, onChange, disabled, label, id, className, ...rest }: ToggleProps) {
  const control = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-raised",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={clsx(
          "ml-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );

  if (!label) return control;

  return (
    <label className={clsx("flex items-center gap-2.5", !disabled && "cursor-pointer")}>
      {control}
      <span className="text-sm text-ink-2">{label}</span>
    </label>
  );
}
