- **The meetings list paginates, and global search arrives (#1651).** The dashboard's meetings
  list now loads incrementally — a keyboard-accessible "Load more" button fetches the next page
  (`limit`/`offset`) instead of the whole history at once; the phase-aware poll re-fetches the
  full currently-loaded window on every tick, so a meeting that goes live on a later page never
  drops out of view. Per-tab counts are gone (meeting-api's `GET /meetings` reports no total, so a
  count built from loaded rows would only ever describe what happened to load) in favour of one
  honest "N loaded" line. A new global search — `Ctrl+K`/`Cmd+K` from anywhere, or the search box
  in the top bar — hits `GET /transcripts/search` and lands on `/search`: results are grouped by
  meeting with the matched text highlighted, and each hit links straight to the meeting, scrolled
  to and highlighting the matching segment. The list's own search box is now explicitly scoped to
  "Filter loaded meetings", with Enter handing the same text to the new global search — one clear
  place for "search what's on screen" versus "search everything, including what was said". Under
  the hood, the proxy's query-parameter allowlist moved from one global set applied to every
  route to each route declaring its own permitted parameters with their own shape checks, so the
  new free-text `q` parameter can never ride along to a route that never asked for one.
