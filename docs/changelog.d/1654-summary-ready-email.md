- **A dashboard-sent ("Send Bot") meeting now tells its owner when it's ready, not just calendar
  invites (#1654).** `email_minutes` mails the meeting's organiser — a name only a calendar invite
  supplies — so an ad hoc bot's owner (`uid`, a platform id, never an address) heard nothing when
  their meeting finished. `post_meeting`'s new last step, `email_owner_ready`, closes that gap:
  for a meeting with no organiser it resolves the owner's address and mails them, subject to the
  same `mail_minutes` setting `email_minutes` already honours, with a short excerpt (the
  `summary.v1` note's Overview section, when there is one) and one link into the dashboard. An
  invite-originated meeting is untouched — `email_minutes` already addressed its organiser, so the
  new step is a clean no-op for it. The link needs `VEXA_FLOWS_DASHBOARD_URL` set (a follow-up:
  no deploy surface in this repo wires it yet); unset, the mail still sends, with no link. See
  [Report after every meeting](/how-to/post-meeting-report#email-when-its-ready-db-80).
