- **Dashboard: a design system and app shell replace the hand-rolled per-page styling (#1638).**
  `clients/dashboard/src/components/ui/` adds seven small, hand-written primitives — `Button`,
  `Input`, `Dialog`, `Toggle`, `Tabs`, `Toast`, `Skeleton` — all reading colours and radii from the
  existing CSS variables in `app/globals.css`, so light and dark both work with no theme
  conditional in any component. Every existing component (`SendBotDialog`, `MeetingsView`,
  `MeetingDetail`, `LoginForm`, `EmptyState`) migrates to them; `SendBotDialog`'s hand-rolled modal
  and its `<span role="checkbox">` fake auto-join toggle are gone, replaced by `Dialog` (focus
  trap, Escape, backdrop click, focus returned to the opener) and `Toggle` (a real
  `role="switch"`). Sending a bot and connecting/updating/syncing/removing a calendar now confirm
  or fail through a new `Toast` provider, alongside the inline confirmation DB-02a already fixed.
  The shell (`Shell.tsx`) adds a skip-to-content link, an account menu (name, email, sign out) in
  the top bar, and a rail that collapses to a drawer down to 375px. Navigation renders from a
  single declared list (`nav.ts`) filtered to implemented destinations, so the sidebar can never
  link to a page that doesn't exist yet — five of its six target entries (Upcoming, Calendar,
  Recordings, Settings, Billing) stay unlisted until their own task ships the route and flips one
  flag. No new runtime dependency: the primitives are hand-written on top of `clsx` and
  `lucide-react`, already present. Accessibility is proven with new Playwright specs
  (`e2e/specs/10-a11y-keyboard.spec.ts`, `e2e/specs/11-mobile-viewport.spec.ts`) covering
  keyboard-only operation of the Add Bot flow, the dialog's focus trap and focus return, the
  switch's role and keyboard operation, and no horizontal scroll at 375×812 — not a Lighthouse
  score, which this harness has no way to measure without a new dependency it declines to add; see
  `e2e/specs/README.md` for why. See
  [`clients/dashboard/src/components/ui/README.md`](https://github.com/Vexa-ai/vexa/blob/main/clients/dashboard/src/components/ui/README.md).
