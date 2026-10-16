"use client";
/** "Where do I find my calendar's ICS link?" — one tab per provider (`lib/icsGuide.ts`), each with
 *  numbered steps, a button that opens that provider's own settings page in a new tab, and a
 *  screenshot under any step that has one. */
import { ExternalLink } from "lucide-react";
import { ICS_GUIDES, icsGuide, type IcsProviderId } from "@/lib/icsGuide";
import { Tab, Tabs } from "./ui";

interface IcsGuideProps {
  provider: IcsProviderId;
  onProviderChange: (provider: IcsProviderId) => void;
}

export function IcsGuide({ provider, onProviderChange }: IcsGuideProps) {
  const guide = icsGuide(provider);
  return (
    <div className="flex flex-col gap-3" data-testid="ics-guide">
      <Tabs value={provider} onChange={(v) => onProviderChange(v as IcsProviderId)} label="Your calendar">
        {ICS_GUIDES.map((g) => (
          <Tab key={g.id} value={g.id}>
            {g.label}
          </Tab>
        ))}
      </Tabs>

      {(guide.settings || guide.altSettings) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {guide.settings && (
            <a
              href={guide.settings.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-line-strong"
            >
              {guide.settings.label} <ExternalLink size={13} aria-hidden />
            </a>
          )}
          {guide.altSettings && (
            <a
              href={guide.altSettings.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent underline underline-offset-2"
            >
              {guide.altSettings.label} <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-3" aria-label={`${guide.label}: find your ICS link`}>
        {guide.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent"
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-2">{step.text}</p>
              {step.image && (
                // Plain <img>: static help screenshots served from /public, no optimisation needed.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={step.image}
                  alt={step.imageAlt ?? step.text}
                  loading="lazy"
                  className="mt-2 w-full rounded-lg border border-line"
                />
              )}
            </div>
          </li>
        ))}
      </ol>

      {guide.note && <p className="text-xs text-ink-3">{guide.note}</p>}
    </div>
  );
}
