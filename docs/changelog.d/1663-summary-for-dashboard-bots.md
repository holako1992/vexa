- **A dashboard-sent bot now gets its meeting summary too, not just calendar invites (#1663).**
  meeting-api tells flows about every bot it dispatches, invite or not — but its `meeting.completed`
  carries only `{uid, meeting_id, native, platform, completion_reason}`, no organiser and no
  attendees, and `post_meeting`'s mail steps used to crash on that missing `organizer` before ever
  reaching the summary step. `email_minutes` and `drop_to_attendees` now end cleanly — with a
  recorded reason — when a meeting has no invite context; an ad hoc meeting mails nobody (unchanged)
  and the report still lands on the bot owner's own desk, addressed by `uid` directly. The DB-60
  summary (`meetings/<row_id>/summary.md`) is written either way. `deploy/compose/docker-compose.yml`
  now points meeting-api's `VEXA_FLOWS_API_URL` at the in-stack `flows-api` by default (matching how
  agent-api's own edge already does), so a stock `docker compose up` needs no `.env` change for this
  to work; set it empty to keep a deployment that carries no flows domain unchanged. See
  [Report after every meeting](/how-to/post-meeting-report#which-meetings-get-one-db-60b).
