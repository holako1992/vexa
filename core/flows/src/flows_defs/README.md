# flows_defs — the flows themselves

Product behavior as DATA: each flow is a typed event trigger plus an ordered list of step
FUNCTIONS (a typo is a registration error, never a 2pm KeyError; strings exist only in the
database). One file per flow; reviewed like any product change; a new version is a new
registration — in-flight reactions keep the version stamped at admission, new events select the
newest (Registry.match).

## `production.py` and `production_agent.py`

The production definitions are in TWO modules, split by one property: whether the flow still does
anything when the **agent domain is not deployed** (PRD decisions 40.6/40.7).

| | Flows | With no agent domain |
|---|---|---|
| `production.py` | `invite_intake` · `post_meeting` · `live_meeting` · `friction_log` · `onboarding` · `dunning` | they still run — the invite is accepted, the bot joins, the meeting is recorded, and the agent-reaching steps answer `agent:not_present` |
| `production_agent.py` | `meeting_prep` · `email_chat` · `desk_setup` · `desk_claim` | **not registered at all** — a conversation with an agent and two cards on a desk have nothing to degrade to |

`production.build()` calls `production_agent.build()` last, and only when
`flows_steps.common.domain_present("agent")` — the same predicate the engine consults for every
`needs=("agent",)` step, reading the same key (`VEXA_FLOWS_AGENT_API_URL`) and never probing. A cut
that deletes `production_agent.py` outright is supported: the seam checks `find_spec` first.

Shared helpers stay in `production.py`, and `production_agent` reads every collaborator **through
the module object handed to its `build(reg, db, home=…)`** — never `from .production import …`. One
`monkeypatch.setattr(production, …)` has to reach both halves.

## DB-60 — the AI note (`commit_meeting_summary`)

Added to `post_meeting` at version 5. It writes `meetings/<row_id>/summary.md` in the
organiser's own workspace — a path derivable from the meeting's ROW ID ALONE, unlike
`drop_to_attendees`'s `kg/entities/meeting/<date>-<slug>.md`, which only a mail recipient can
already resolve. No second agent turn: it reshapes `process_meeting`'s already-grounded report
(re-checking `mt.grounded_in` itself rather than trusting the receipt blindly) and skips — with a
recorded reason, never a silent empty file — a meeting whose transcript is too thin or whose
report does not ground. See `docs/docs/how-to/post-meeting-report.mdx` for the wire contract the
dashboard reads, and `core/flows/tests/test_meeting_summary.py` for the property list.

## DB-80 — the "it's ready" mail for an ad hoc owner (`email_owner_ready`)

`post_meeting`'s LAST step, added at version 6, right after DB-60's. `email_minutes` mails a
calendar invite's organiser; an ad hoc bot (the dashboard's "Send Bot", MCP's
`request_meeting_bot`) carries no organiser at all, so this step reads the same two receipts
`commit_meeting_summary` reads — `process_meeting`'s report and `commit_meeting_summary`'s own
`status` — and mails the meeting's OWNER instead, resolved from `uid` through
`platform_user_email` (the reverse of `ensure_platform_user`). Subject to the same `mail_minutes`
setting `email_minutes` honours; a clean no-op when an organiser IS on the meeting, since that
mail already went out. See `docs/docs/how-to/post-meeting-report.mdx#email-when-its-ready-db-80`
and `core/flows/tests/test_meeting_ready_email.py` for the property list.

## DB-78 — the dunning mail (`dunning` flow, `email_payment_failed`)

A ONE-STEP flow, the same shape as `onboarding`, reacting to `payment.failed` — identity's Stripe
webhook publishes this fact, alongside `subscription.changed`, ONLY for `invoice.payment_failed`,
keyed to the INVOICE rather than the Stripe event id (`admin_api/app/events.py`'s
`payment_failed_source_id`) so a redelivered webhook event or a Stripe retry of the same unpaid
invoice admits no second reaction here. The step itself carries the same `mail_outbox_sent`
belt-and-suspenders `email_owner_ready` documents, mails a plain notice with a `/billing` link
(`VEXA_FLOWS_DASHBOARD_URL`) and no price or legal language, and skips cleanly when the platform
user has no email on file. See `docs/docs/how-to/billing.mdx#dunning-and-grace-a-payment-fails`
and `core/flows/tests/test_dunning_email.py` for the property list.
