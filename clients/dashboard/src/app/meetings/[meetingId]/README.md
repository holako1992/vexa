# `src/app/meetings/[meetingId]/` — one meeting

Resolves the signed-in user, then renders `components/MeetingDetail` for this row id inside a
`Suspense` boundary. The read behind it is owner-scoped at the gateway, so an id belonging to
someone else returns nothing to render rather than someone else's transcript.

The `Suspense` boundary exists for DB-44: `MeetingDetail` reads a `?t=<seconds>` query parameter
(a global-search hit's link) with `useSearchParams` to scroll to and highlight the matching
transcript segment, and Next.js requires a `Suspense` boundary around that hook even on a
`force-dynamic` route.
