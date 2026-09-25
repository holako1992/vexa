# `src/components/` — the UI

Client components. They receive identity as props (resolved on the server) and fetch data through
`lib/api.ts`; none of them knows a backend host or holds a key.

- `ui/` — the primitives (`Button`, `Input`, `Dialog`, `Toggle`, `Tabs`, `Toast`, `Skeleton`). Every
  component below is built from these; see `ui/README.md`. No component outside `ui/` should
  hand-roll a dialog, a switch, a tab strip or a toast — that duplication is exactly what `ui/`
  exists to remove.
- `Shell` — the frame: skip-to-content link, a left rail that collapses to a drawer below `md`
  (responsive down to 375px), a top bar with the account menu (name, email, sign out). Renders on
  every page except `/login`, which is designed to sit outside it (see `app/login/page.tsx`).
  Navigation comes from `nav.ts` — see "Adding a nav entry" below.
- `nav.ts` — the single declared navigation list. `Shell` renders only its `VISIBLE_NAV_ITEMS`
  (items with `implemented: true`), so this file is the one place that decides what the sidebar
  links to; nothing else in the tree references a nav destination.
- `MeetingsView` — the list: search, phase tabs (`ui/Tabs`), polling, the "Add Bot" action that
  opens `SendBotDialog`.
- `MeetingDetail` — one meeting: header facts, transcript, in-transcript search, copy, download.
  It reads its own row by id; the collection is not a source for a single meeting. Composes the
  four pieces below, all of which check `meeting.shared` themselves rather than trusting the
  caller to gate them — a shared meeting (the viewer isn't the owner) renders none of them.
- `SummaryPanel` — the post-meeting AI note (DB-60), above the transcript. Reads `GET
  /api/vexa/meetings/<id>/summary`, parses it with `lib/summary.ts`, and renders five distinct
  states (not-ended, shared-owner-only, pending/polling, skipped, complete) — never a single
  generic "no summary". No markdown library and no `dangerouslySetInnerHTML`: the note's shape is
  small and fixed, so turning it into JSX directly is both simpler and incapable of weakening the
  nonce-based CSP. Inline `**strong**`/`_emphasis_` in the note's prose (e.g. the producer's own
  `_none recorded in this meeting._` placeholder) renders as `<strong>`/`<em>` through its local
  `Inline` component, wired to `lib/summary.ts`'s `parseInlineEmphasis` — never as literal
  underscores, and never through raw HTML.
- `BillingView` — DB-74's read-only billing page (`/billing`): plan, usage meters, reset date,
  and any past-due / cancel-at-period-end note, from `GET /api/vexa/user/entitlements`
  (`lib/entitlements.ts`'s formatters). No checkout or portal buttons — see the file's own header
  comment for why; a later task fills that slot once DB-73's Stripe endpoints are final.
- `BotControls` — DB-41: the bot's live status (from `GET /bots/status`) and a **Stop recording**
  button behind `ui/Dialog`'s confirm. A join-failure `reason`, when the producer recorded one, is
  shown verbatim — never reworded.
- `MeetingActions` — DB-42's inline rename (pencil → `Input` → `POST
  /meetings/<id>/annotate`, not `PATCH` — see that file's header comment for why) and delete
  (behind `ui/Dialog`, redirects to the list with a toast on success).
- `Participants` — DB-42: the invite + speaker roster from `GET
  /meetings/<platform>/<native>/participants`, shown as chips in the header. Renders nothing when
  the meeting has no native id or the roster is empty — there is no "0 participants" state to get
  wrong.
- `SendBotDialog` — the dispatch door: paste a meeting link and send a bot, or manage the ICS
  calendar connections that arm an unattended join. It parses the link in the browser only to
  decide what to send and what to disable; the platform and id it derives are re-checked at the
  proxy's write allowlist, which is the boundary that actually refuses. Built on `ui/Dialog` and
  `ui/Toggle`. Every mutation (send bot, connect/update/sync/remove a calendar) confirms or fails
  through `ui/Toast`'s `useToast()`, in addition to the inline "Bot is joining the meeting."
  confirmation `SendBotDialog` already showed (DB-02a fixed that inline confirmation; DB-04 did not
  touch it, only added the toast alongside it). DB-75's paywall: a read-only remaining-allowance
  line under Send (`lib/entitlements.ts`'s `formatRemainingAllowance`, informational only — it
  never disables sending, because a stale client read must not refuse a legitimate one), and a
  quota-exceeded send branches on the `POST /bots` response body's `error: "quota_exceeded"`
  field, never on the 402 status alone, showing the reset date and a link to `upgrade_url` (or
  `/billing` when the producer sent none).
- `LoginForm` — the sign-in card. The `next` parameter passes through `safeNext()` from
  `lib/security.ts`, which is why it cannot become an open redirect.
- `MeetingDetail`'s speaker chips mix one hue into transparent rather than using a frozen pastel,
  so they land correctly on either theme's card colour.
- `StatusPill` — shows meeting-api's own status word; the dashboard picks the colour, never the
  vocabulary.
- `EmptyState` — loading, failed and genuinely-empty are three distinct states here. A failure that
  renders as "no meetings" is the bug this file exists to make impossible. `LoadingState` pairs a
  `role="status"` announcement with `ui/Skeleton` placeholders — the pulse alone tells a screen
  reader nothing.

The design language: light canvas, one calm blue accent, hairline borders, type carrying the
hierarchy. Tokens live in `app/globals.css`; the dark set redefines the same variable names, so no
component carries a theme conditional.

## Adding a nav entry (for a later task's new page)

1. Build the page under `src/app/<slug>/page.tsx`. Compose it from `Shell` the way
   `src/app/page.tsx` and `src/app/meetings/[meetingId]/page.tsx` already do:
   ```tsx
   import { redirect } from "next/navigation";
   import { currentUser } from "@/lib/session";
   import { Shell } from "@/components/Shell";

   export const dynamic = "force-dynamic";

   export default async function YourPage() {
     const user = await currentUser();
     if (!user) redirect("/login");
     return (
       <Shell user={{ email: user.email, name: user.name }}>
         {/* your view, built from src/components/ui/ */}
       </Shell>
     );
   }
   ```
2. In `nav.ts`, flip that item's `implemented` to `true`. That is the whole change — `Shell` picks
   it up automatically because it renders `VISIBLE_NAV_ITEMS`, not the full list. Do not add a
   "coming soon" placeholder page for an item you are not shipping yet; leave `implemented: false`
   and it simply will not render.
