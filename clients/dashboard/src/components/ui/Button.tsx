"use client";
/** The one button. Every clickable action in this app renders through this component so variant,
 *  size and the loading/disabled treatment are defined in exactly one place. */
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the leading icon slot and disables the button. The label stays
   *  on screen — swapping it out would make the click target shift under the pointer. */
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90 disabled:opacity-50",
  secondary: "border border-line text-ink-2 hover:bg-raised disabled:opacity-50",
  danger: "bg-live text-white hover:opacity-90 disabled:opacity-50",
  ghost: "text-ink-2 hover:bg-raised disabled:opacity-40",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-10 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-5 text-[15px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, disabled, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-semibold transition-colors disabled:cursor-not-allowed",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === "sm" ? 13 : 15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});
