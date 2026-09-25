"use client";
/** Toast provider + `useToast()` hook. One `aria-live="polite"` region for the whole app (mounted
 *  once in `app/layout.tsx`), so every mutation confirms or fails through the same channel
 *  instead of each component inventing its own inline banner.
 *
 *  Success/info toasts auto-dismiss; error toasts get a much longer timeout (and can still be
 *  dismissed by hand) so a failure is never gone before anyone had a chance to read it — a toast
 *  that vanishes on its own defeats the point of reporting the failure at all. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import clsx from "clsx";

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Override the default auto-dismiss delay (ms). `0` means "never auto-dismiss". */
  duration?: number;
}

interface ToastRecord extends Required<Pick<ToastInput, "tone" | "title">> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 4_000,
  info: 4_000,
  // Errors matter more and are usually longer to read — give them roughly 2.5x the routine
  // duration, and never so short a fast skim would miss it.
  error: 10_000,
};

const ICON: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-ok/30 bg-ok-soft text-ok",
  error: "border-live/30 bg-live-soft text-live",
  info: "border-line bg-card text-ink",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      const tone = toast.tone ?? "info";
      setToasts((prev) => [...prev, { id, tone, title: toast.title, description: toast.description }]);
      const duration = toast.duration ?? DEFAULT_DURATION[tone];
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className={clsx(
                "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-lg",
                TONE_CLASS[t.tone],
              )}
            >
              <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs opacity-90">{t.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be called inside <ToastProvider>");
  return ctx;
}
