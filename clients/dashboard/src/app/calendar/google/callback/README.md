# `src/app/calendar/google/callback/` — Google's OAuth callback page

`/calendar/google/callback` (DB-31): resolves the signed-in user, then renders
`components/GoogleCalendarCallback` inside `Shell`, the same split every other route in
`src/app/` uses. No nav-rail entry — reached only from Google's own redirect, the same way
`/search` is reached only from the search box.

`GoogleCalendarCallback` reads `code`/`state` (or `error`) off the query string with
`useSearchParams`, which Next.js requires a `Suspense` boundary for even though this route is
`force-dynamic` — this file's whole job beyond the usual session check is providing that boundary
with a `LoadingState` fallback, so landing here never flashes an unstyled blank page while the
client bundle hydrates.
