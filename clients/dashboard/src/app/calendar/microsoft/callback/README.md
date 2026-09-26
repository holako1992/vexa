# `src/app/calendar/microsoft/callback/` — Microsoft's OAuth callback page

`/calendar/microsoft/callback` (DB-32/DB-33): resolves the signed-in user, then renders
`components/CalendarOAuthCallback` with `provider="microsoft"` inside `Shell`, the same split
every other route in `src/app/` uses. No nav-rail entry — reached only from Microsoft's own
redirect, the same way `/search` is reached only from the search box.

`CalendarOAuthCallback` is the ONE component both this page and `../../google/callback/page.tsx`
render (with a different `provider`) — see that component's own header comment for the shared
flow it implements: reading `code`/`state` (or `error`) off the query string with
`useSearchParams`, which Next.js requires a `Suspense` boundary for even though this route is
`force-dynamic` — this file's whole job beyond the usual session check is providing that boundary
with a `LoadingState` fallback, so landing here never flashes an unstyled blank page while the
client bundle hydrates.
