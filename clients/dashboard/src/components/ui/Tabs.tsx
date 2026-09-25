"use client";
/** The WAI-ARIA "tabs" pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ — a `tablist` of
 *  `tab` buttons with roving tabindex (only the selected tab is in the Tab order) and Left/Right/
 *  Home/End arrow-key navigation that both moves focus and activates the tab (automatic
 *  activation, the simpler of the pattern's two documented models and the right fit for cheap-to-
 *  render panels like a phase filter). */
import { Children, isValidElement, useRef } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import clsx from "clsx";

export interface TabsProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  children: ReactNode;
  className?: string;
}

export interface TabProps {
  value: string;
  children: ReactNode;
  className?: string;
}

/** A single tab's declaration. `Tabs` reads its props directly and renders the actual `role="tab"`
 *  button itself — `Tab` never renders on its own, it is only a typed marker so the selection
 *  wiring (onClick, aria-selected, roving tabindex) lives in exactly one place. */
export function Tab(_props: TabProps): null {
  return null;
}

export function Tabs({ value, onChange, label, children, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const items = Children.toArray(children).filter(isValidElement) as ReactElement<TabProps>[];
  const values = items.map((item) => item.props.value);

  function focusAndSelect(nextValue: string) {
    onChange(nextValue);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(nextValue)}"]`)?.focus();
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = values.indexOf(value);
    if (i === -1) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAndSelect(values[(i + 1) % values.length]!);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAndSelect(values[(i - 1 + values.length) % values.length]!);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAndSelect(values[0]!);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAndSelect(values[values.length - 1]!);
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={className ?? "flex gap-1 rounded-lg bg-raised p-1"}
    >
      {items.map((item) => {
        const selected = item.props.value === value;
        return (
          <button
            key={item.props.value}
            type="button"
            role="tab"
            id={`tab-${item.props.value}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${item.props.value}`}
            tabIndex={selected ? 0 : -1}
            data-tab-value={item.props.value}
            onClick={() => onChange(item.props.value)}
            className={clsx(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              item.props.className,
              selected ? "bg-card text-ink shadow-sm" : "text-ink-2 hover:text-ink",
            )}
          >
            {item.props.children}
          </button>
        );
      })}
    </div>
  );
}

/** Optional: wrap a tab's content so it carries the matching `role="tabpanel"` id/labelling. Not
 *  every `Tabs` consumer needs a distinct panel element (a filter that just narrows a list below
 *  it does not), so this is separate from `Tabs` itself rather than forced on every call site. */
export function TabPanel({ value, activeValue, children }: { value: string; activeValue: string; children: ReactNode }) {
  if (value !== activeValue) return null;
  return (
    <div role="tabpanel" id={`tabpanel-${value}`} aria-labelledby={`tab-${value}`} tabIndex={0}>
      {children}
    </div>
  );
}
