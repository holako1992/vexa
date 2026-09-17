# `src/app/meetings/` — the meeting routes

Only the detail route lives here; the list is the home page. A meeting is addressed by its meeting-api
**row id**, never by the native meeting code — the native code repeats across re-sends of the same
link and across tenants, so keying a read by it would show one run's words under another's heading.
