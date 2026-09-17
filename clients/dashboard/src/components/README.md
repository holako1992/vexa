# `src/components/` — the UI

Client components. They receive identity as props (resolved on the server) and fetch data through
`lib/api.ts`; none of them knows a backend host or holds a key.

- `Shell` — the frame: left rail, identity, sign-out, mobile rail toggle.
- `MeetingsView` — the list: search, phase tabs, polling.
- `MeetingDetail` — one meeting: header facts, transcript, in-transcript search, copy, download.
- `LoginForm` — the sign-in card. The `next` parameter passes through `safeNext()` from
  `lib/security.ts`, which is why it cannot become an open redirect.
- `MeetingDetail`'s speaker chips mix one hue into transparent rather than using a frozen pastel,
  so they land correctly on either theme's card colour.
- `StatusPill` — shows meeting-api's own status word; the dashboard picks the colour, never the
  vocabulary.
- `EmptyState` — loading, failed and genuinely-empty are three distinct states here. A failure that
  renders as "no meetings" is the bug this file exists to make impossible.

The design language: light canvas, one calm blue accent, hairline borders, type carrying the
hierarchy. Tokens live in `app/globals.css`; the dark set redefines the same variable names, so no
component carries a theme conditional.
