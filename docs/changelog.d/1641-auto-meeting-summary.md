- **A summary lands automatically when a meeting completes, no dispatch required (#1641).**
  `post_meeting`'s last step now commits a `summary.v1` note to `meetings/<row_id>/summary.md` in
  the organiser's own workspace — a path a caller can derive from the meeting's row id alone, read
  over the same `GET /agent/workspace/file?path=...` door as any other workspace file. It reuses
  the same grounded report the full post-meeting turn already produced (no second model call), and
  a meeting with too little transcript, no report, or an ungrounded report gets a `status: skipped`
  note with a recorded reason instead of a silent empty file. See
  [Report after every meeting](/how-to/post-meeting-report#automatic-the-ai-note-db-60).
