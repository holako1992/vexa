- **The meeting page grows a summary, bot controls, and rename/delete/participants (#1645).** The
  dashboard's meeting detail page now shows the AI-generated post-meeting summary (overview,
  decisions, action items, open questions — see [Report after every meeting](/how-to/post-meeting-report#automatic--the-ai-note-db-60))
  above the transcript, with distinct states for not-yet-generated, still-generating, skipped, and
  a shared meeting whose summary belongs to its owner. It also adds a **Stop recording** control
  with a confirm dialog, a verbatim join-failure reason when the producer recorded one, inline
  title rename, meeting delete, and the participants roster — all hidden on a meeting shared with
  you rather than someone else's. No new workspace-file proxy: the summary reads through a single
  numeric-id-only route the server composes itself.
