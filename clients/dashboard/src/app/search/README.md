# `src/app/search/` — the global search page

`/search` (DB-44): resolves the signed-in user, then renders `components/SearchView` inside
`Shell`, the same split every other route in `src/app/` uses. No nav-rail entry — see
`components/Shell.tsx`'s header comment for why search lives in the top bar instead.

`SearchView` reads its `q` query parameter with `useSearchParams`, which Next.js requires a
`Suspense` boundary for even though this route is `force-dynamic` — this file's whole job beyond
the usual session check is providing that boundary with a `LoadingState` fallback, so a direct
link to `/search?q=...` never flashes an unstyled blank page while the client bundle hydrates.
