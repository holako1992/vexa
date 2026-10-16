- **Post-meeting summaries run end to end.** flows' summary turn sends agent-api only what it
  accepts (no meeting-room fields, which it rejected with 422) and names the meeting as chat context,
  so agent-api folds the transcript into the prompt; the grounding check reads any script (an Arabic
  quote no longer fails it); a summary that cannot be made leaves a `status: skipped` note with a
  plain reason instead of "still being generated" forever; `## Summary` / `## Key quote` headings
  land in the overview; and an untitled meeting's mails and desk pages use the report's own title. A
  default `behavior/prompts/process-meeting.md` ships, and `VEXA_FLOWS_AGENT_API_URL` must be set
  for summaries to run at all.
