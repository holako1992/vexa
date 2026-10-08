# flows_integrations

The edge: processes that turn the outside world into FACTS. `mailbox.py` — the real inbox:
ICS → invite.received; thread-matched replies → mail.reply; durable cursor (mail_cursor row)
so restarts resume, never re-admit.

`inbox.py` is the source seam underneath it: `VEXA_MAIL_INBOX=imap` (default) polls
imap.gmail.com exactly as before, `=mailpit` polls the dev stack's mail double over REST
(`VEXA_MAILPIT_URL`, filtered on `VEXA_MAIL_ADDR`, no mail password needed). Both fetch the raw
RFC822 source and share one parse, so the two produce identical facts. Mailpit ids are random
rather than monotonic, so its position is a `Created` watermark (`mail_cursor.token`) plus a
seen-id set (`mail_seen`) — see the contracts at the top of `inbox.py`.

`account_erasure.py` is flows' part of immediate account deletion (`POST /internal/accounts/{subject}/erase`
on flows-api, internal tier: `X-Internal-Secret` == `INTERNAL_API_SECRET`, unset → 503, wrong → 403). It
cancels the person's queued reactions first, then deletes the reactions they own with their receipts and
signals, then the rows keyed by uid (`mail_thread`, `mail_outbox_sent`) or sender address
(`mail_quarantine`, `mail_turn`). The addresses come from the request body (`{"emails": [...]}`, optional)
and from admin-api's record of the account. A reaction that only lists the person as a participant belongs to
the organizer and is kept. Idempotent; a failing stage answers `500 {"error", "stage"}`.
