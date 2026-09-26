# `src/app/` — routes

- `layout.tsx` · `globals.css` — the document shell and the design tokens.
- `page.tsx` — home: the meetings list inside the app shell.
- `meetings/[meetingId]/page.tsx` — one meeting and its transcript. Wraps `MeetingDetail` in a
  `Suspense` boundary — DB-44's `?t=<seconds>` scroll-to-segment link reads it via
  `useSearchParams`, which Next requires one for even under `force-dynamic`.
- `search/page.tsx` — DB-44's global search results (`/search?q=`). Same `Suspense` need, same
  reason; see `components/Shell.tsx`'s header comment for why search lives in the top bar rather
  than a nav-rail entry.
- `billing/page.tsx` — DB-74's read-only billing page: plan, usage, reset date.
- `upcoming/page.tsx` — DB-33's `/upcoming`: every planned meeting grouped by day, with the
  per-meeting Join / Don't join override and "Sync now".
- `calendar/page.tsx` — DB-34's `/calendar`: per-connection health (last sync, last error, events
  touched) and Reconnect. `calendar/google/` and `calendar/microsoft/` hold each provider's OAuth
  `callback/` route (DB-31, DB-32/DB-33) — no nav-rail entry of their own; see that directory's
  own `README.md`.
- `login/page.tsx` — the sign-in page. It computes on the SERVER which providers exist, so no OAuth
  identifier is ever sent to the browser.
- `api/` — the handlers.

Every page here is a server component that resolves the signed-in user before rendering and
redirects to `/login` when there is none. That is a second gate behind `middleware.ts`, not a
replacement for it: the middleware answers cheaply on every request, the page answers with the
verified identity.
