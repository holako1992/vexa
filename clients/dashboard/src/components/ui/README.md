# `src/components/ui/` — the primitives

The small set every other component in this app is built from. None of them knows about meetings,
bots or calendars — they take props and emit accessible markup styled from the CSS variables in
`app/globals.css`. No component outside this directory should hand-roll a dialog, a switch, a tab
strip or a toast; that duplication is exactly what this directory exists to remove.

- **`Button.tsx`** — `variant` (`primary` · `secondary` · `danger` · `ghost`), `size` (`sm` · `md`
  · `lg`), `loading` (shows a spinner in the icon slot and disables the button without moving the
  label, so the click target doesn't shift under the pointer), `icon`. Every clickable action in
  `src/` renders through this component.
- **`Input.tsx`** — `label`, `hint`, `error`, `icon` (a decorative leading glyph). Wires
  `htmlFor`/`id`/`aria-describedby` itself; an `error` replaces `hint` rather than stacking under
  it, and sets `aria-invalid`.
- **`Dialog.tsx`** — `open`, `onClose`, `title`, `description?`, `icon?`. Focus moves into the
  panel when it opens, Tab is trapped inside it, Escape closes it, a backdrop click closes it, and
  focus returns to whatever had focus before it opened. `aria-modal="true"`, labelled by `title`.
  This is the only `role="dialog"` in the app — `SendBotDialog` used to hand-roll its own; that
  code is gone.
- **`Toggle.tsx`** — a real `role="switch"` with `aria-checked`, built on a native `<button>` so
  Space/Enter and a click both just work with no keydown handler of its own. Replaces the
  `<span role="checkbox">` fake toggle `SendBotDialog` used to use for calendar auto-join — a
  checkbox and a switch are different controls with different expected keyboard behaviour and
  different screen-reader announcements, and the old markup claimed to be the wrong one.
- **`Tabs.tsx`** — the WAI-ARIA tabs pattern (`Tabs` + `Tab` + optional `TabPanel`): a `tablist` of
  `tab` buttons with roving tabindex (only the selected tab is in the page's Tab order) and
  Left/Right/Home/End arrow-key navigation that moves focus and activates the tab in one step
  (automatic activation — the right model when switching tabs is cheap, as it is for every current
  use). `Tab` never renders on its own; it is a typed prop carrier that `Tabs` reads directly, so
  the selection wiring lives in exactly one place instead of being re-implemented at each call
  site.
- **`Toast.tsx`** — `ToastProvider` (mounted once, in `app/layout.tsx`) + `useToast()`. One
  `aria-live="polite"` region for the whole app. Success/info toasts auto-dismiss after 4s; error
  toasts get 10s and `role="alert"` — long enough that a failure can't vanish before anyone reads
  it — and every toast still has a manual dismiss button.
- **`Skeleton.tsx`** — a pulsing placeholder block, `aria-hidden`. Pair it with a `role="status"`
  text announcement elsewhere in the view (see `LoadingState` in `../EmptyState.tsx`); the pulse
  itself communicates nothing to a screen reader.

All seven read their colours and radii from the CSS variables in `app/globals.css` — none of them
contains a light/dark conditional. That is also the rule for anything built on top of them.

## Adding a page that uses these

Compose a page from `Shell` (`../Shell.tsx`) the way `src/app/page.tsx` already does, build its UI
from the primitives above, then see `../README.md` for the one-line change that adds its nav entry.
