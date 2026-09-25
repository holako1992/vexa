/** The single declared navigation list.
 *
 *  This is the ONE place a nav destination is declared. `Shell` renders `VISIBLE_NAV_ITEMS` —
 *  never `NAV_ITEMS` — so an item with `implemented: false` can be listed here (it says what the
 *  target information architecture is) without ever becoming a clickable link to a page that
 *  does not exist. There is no "coming soon" placeholder page anywhere in this tree; an
 *  unimplemented item simply does not render.
 *
 *  A later task adds its page by:
 *    1. Building the route under `src/app/<slug>/page.tsx` (compose it from `Shell` the same way
 *       `src/app/page.tsx` and `src/app/meetings/[meetingId]/page.tsx` already do).
 *    2. Flipping that item's `implemented` to `true` below.
 *  That is the whole change. No other file references a nav item.
 */
import type { ComponentType } from "react";
import { CalendarDays, Clock, CreditCard, LayoutGrid, Settings, Video } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  /** Flip to `true` in the SAME commit that ships the route this points at. */
  implemented: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Meetings", icon: LayoutGrid, implemented: true },
  { href: "/upcoming", label: "Upcoming", icon: Clock, implemented: false },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, implemented: false },
  { href: "/recordings", label: "Recordings", icon: Video, implemented: false },
  { href: "/settings", label: "Settings", icon: Settings, implemented: false },
  { href: "/billing", label: "Billing", icon: CreditCard, implemented: false },
];

/** What `Shell` actually renders. Filtering here — once — is what makes "never point at a page
 *  that does not exist" a property of the data rather than a discipline every caller must
 *  remember. */
export const VISIBLE_NAV_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) => item.implemented);
