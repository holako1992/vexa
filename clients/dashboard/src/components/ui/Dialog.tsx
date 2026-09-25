"use client";
/** A modal dialog: focus trap, Escape to close, focus returns to whatever opened it, backdrop
 *  click closes, `aria-modal`, labelled by its own title. Every modal in this app is this
 *  component — there is no second hand-rolled `role="dialog"` anywhere in `src/`. */
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** A small leading badge in the header, e.g. an icon in a tinted square. Purely decorative. */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, description, icon, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Captured during RENDER, not in an effect: a child inside the dialog (e.g. an `autoFocus`
  // input) steals focus synchronously while its DOM node is inserted, which happens during
  // React's commit — BEFORE any `useEffect` (or even `useLayoutEffect`) runs. By the time an
  // effect could read `document.activeElement`, the opener is already gone. The render phase
  // runs before any of that commit work, so this is the last point at which the opener is still
  // the actually-focused element. `useRef`'s initial-value argument only sticks on the first
  // render of this instance (later renders' evaluations are discarded by React), which is
  // exactly the "on open" semantics this needs, since a whole new `Dialog` instance mounts each
  // time a consumer opens one.
  const openerRef = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement) : null);

  // Move focus into the panel once it mounts — unless a descendant already grabbed it via its
  // own `autoFocus` (that already fired, synchronously, during commit — this only fills in when
  // nothing inside the panel is focused yet).
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel)?.focus();
    }

    return () => {
      // Return focus to the opener on unmount / close, unless the page already moved focus
      // somewhere more specific (e.g. a route change) in the meantime.
      const opener = openerRef.current;
      if (opener && document.body.contains(opener)) opener.focus();
    };
  }, [open]);

  // Escape / backdrop-click / the header's own X button all close the dialog FROM INSIDE it —
  // return focus to the opener proactively, right here, rather than leaving it to the cleanup of
  // the effect above. That cleanup is a correct fallback for a consumer that unmounts this
  // component some other way, but relying on it for the common path races the browser's own
  // "move focus to <body> when the focused element is detached" behaviour, which fires
  // synchronously during the same unmount that removes this panel from the DOM — sometimes
  // winning before the passive-effect cleanup gets a chance to call `opener.focus()` after it.
  function closeAndRestoreFocus() {
    const opener = openerRef.current;
    if (opener && document.body.contains(opener)) opener.focus();
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        // Focus escaped the panel (e.g. a programmatic blur) — pull it back in rather than let
        // Tab hand control to the page behind the backdrop.
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAndRestoreFocus();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={className ?? "w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl"}
      >
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          {icon && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-xs text-ink-3">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={closeAndRestoreFocus}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised"
          >
            <X size={17} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
