- **`GET /meetings` now reports `has_more`, and the dashboard trusts it (#1673).** meeting-api's
  meetings-list handler was discarding the store's own `has_more` return value; it now forwards it
  on the response envelope, exactly as `GET /bots` already does. The dashboard's meetings list
  reads it verbatim instead of guessing "another page may exist" from page length — a guess that
  was wrong whenever the true total landed on an exact multiple of the page size, and could
  under-report once server-side filtering (`exclude_planned`, a `status` filter) thinned a page
  after the limit was applied upstream. The loaded-count line now says "all meetings loaded" once
  `has_more` is false, instead of staying silent about it. See
  [Meetings API](/api/meetings#list-rows-are-slim-detail-is-full).
