# prompts/ — the words an agent turn starts from

The published showcase of the kickoffs flows hands an agent. A deployment's own wording lives at
`$VEXA_BEHAVIOR_DIR/prompts/` (or an admin's `_global/prompts/` override) and is resolved before
these files; this directory is what a deployment falls back to when it carries neither.

- `process-meeting.md` — the post-meeting summary kickoff. `flows_defs/production.py` reads it
  through `prompt_for(ctx, "process-meeting.md")` and fills `{mid}`, `{native}` and `{date}`. It
  tells the agent to write only from the transcript it is handed, so a summary never invents a
  meeting from its title or invite.

Optional content: a deployment that never dispatches an agent turn carries none of it, and a step
that finds no kickoff reports `not_present` instead of failing (see `PromptAbsent` in
[`production.py`](../../core/flows/src/flows_defs/production.py)).
