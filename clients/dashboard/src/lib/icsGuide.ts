/** The in-app "find your calendar's ICS link" guide, one entry per calendar provider. Pure data:
 *  `IcsGuide.tsx` renders it. A step's `image` names a file under `public/help/ics/`; a step
 *  without one renders as text alone, so the guide stays complete while screenshots are missing
 *  or being replaced after a provider redesigns its settings. */

export type IcsProviderId = "google" | "outlook" | "apple" | "other";

export interface IcsGuideStep {
  text: string;
  /** Path under the dashboard's public root, e.g. `/help/ics/google-1.png`. */
  image?: string;
  imageAlt?: string;
}

export interface IcsGuideLink {
  href: string;
  label: string;
}

export interface IcsProviderGuide {
  id: IcsProviderId;
  label: string;
  /** Opens the provider's own settings page where the link lives. */
  settings?: IcsGuideLink;
  /** A second settings page for the same provider (personal vs work accounts). */
  altSettings?: IcsGuideLink;
  steps: IcsGuideStep[];
  /** What to do when the steps don't match what the person sees. */
  note?: string;
  /** The paste field's example for this provider. */
  placeholder: string;
}

export const ICS_GUIDES: readonly IcsProviderGuide[] = [
  {
    id: "google",
    label: "Google",
    settings: { href: "https://calendar.google.com/calendar/r/settings", label: "Open Google Calendar settings" },
    steps: [
      { text: "Open Google Calendar settings." },
      { text: "On the left, under “Settings for my calendars”, click the calendar you want (usually your name)." },
      { text: "Scroll down to “Integrate calendar”." },
      {
        text:
          "Copy the “Secret address in iCal format” — not the “Public address”. It ends in .ics.",
      },
    ],
    note:
      "No secret address on a work account? Your Google Workspace admin has turned it off — use Connect Google Calendar instead, or ask them. Google can take a few hours to show new events in this link.",
    placeholder: "https://calendar.google.com/calendar/ical/…/private-…/basic.ics",
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    settings: {
      href: "https://outlook.office.com/calendar/options/calendar/SharedCalendars",
      label: "Open Outlook settings (work or school)",
    },
    altSettings: {
      href: "https://outlook.live.com/calendar/0/options/calendar/SharedCalendars",
      label: "Outlook.com (personal)",
    },
    steps: [
      { text: "Open Outlook calendar settings → Shared calendars." },
      { text: "Under “Publish a calendar”, choose your calendar and “Can view all details”." },
      { text: "Click Publish." },
      { text: "Copy the ICS link — not the HTML link." },
    ],
    note:
      "No “Publish a calendar” section? Your organisation's admin has turned publishing off — use Connect Microsoft 365 instead.",
    placeholder: "https://outlook.office365.com/owa/calendar/…/reachcalendar.ics",
  },
  {
    id: "apple",
    label: "Apple iCloud",
    settings: { href: "https://www.icloud.com/calendar/", label: "Open iCloud Calendar" },
    steps: [
      { text: "Open Calendar on your Mac, or iCloud Calendar in a browser." },
      { text: "Next to the calendar you want, click the share icon (or right-click → Share Calendar)." },
      { text: "Tick “Public Calendar” and copy the link." },
      { text: "The link starts with webcal:// — replace that with https:// before pasting it here." },
    ],
    note: "Anyone with an iCloud public calendar link can read that calendar, so keep it private.",
    placeholder: "https://p01-caldav.icloud.com/published/2/…",
  },
  {
    id: "other",
    label: "Other",
    steps: [
      {
        text:
          "In your calendar's settings, look for “Export”, “Subscribe”, “Share” or “iCal / ICS link” (Proton, Fastmail, Zoho, Yahoo and most others have one).",
      },
      { text: "Copy the link. It usually ends in .ics." },
      { text: "If it starts with webcal://, replace that with https://." },
    ],
    placeholder: "https://…/calendar.ics",
  },
];

export function icsGuide(id: IcsProviderId): IcsProviderGuide {
  return ICS_GUIDES.find((g) => g.id === id) ?? ICS_GUIDES[ICS_GUIDES.length - 1];
}
