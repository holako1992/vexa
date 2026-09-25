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
| `production.py` | `invite_intake` · `post_meeting` · `live_meeting` | they still run — the invite is accepted, the bot joins, the meeting is recorded, and the agent-reaching steps answer `agent:not_present` |
| `production_agent.py` | `meeting_prep` · `email_chat` · `desk_setup` · `desk_claim` | **not registered at all** — a conversation with an agent and two cards on a desk have nothing to degrade to |

`production.build()` calls `production_agent.build()` last, and only when
`flows_steps.common.domain_present("agent")` — the same predicate the engine consults for every
`needs=("agent",)` step, reading the same key (`VEXA_FLOWS_AGENT_API_URL`) and never probing. A cut
that deletes `production_agent.py` outright is supported: the seam checks `find_spec` first.

Shared helpers stay in `production.py`, and `production_agent` reads every collaborator **through
the module object handed to its `build(reg, db, home=…)`** — never `from .production import …`. One
`monkeypatch.setattr(production, …)` has to reach both halves.

## DB-60 — the AI note (`commit_meeting_summary`)

`post_meeting`'s LAST step, added at version 5. It writes `meetings/<row_id>/summary.md` in the
organiser's own workspace — a path derivable from the meeting's ROW ID ALONE, unlike
`drop_to_attendees`'s `kg/entities/meeting/<date>-<slug>.md`, which only a mail recipient can
already resolve. No second agent turn: it reshapes `process_meeting`'s already-grounded report
(re-checking `mt.grounded_in` itself rather than trusting the receipt blindly) and skips — with a
recorded reason, never a silent empty file — a meeting whose transcript is too thin or whose
report does not ground. See `docs/docs/how-to/post-meeting-report.mdx` for the wire contract the
dashboard reads, and `core/flows/tests/test_meeting_summary.py` for the property list.
