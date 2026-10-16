- **Delete all recordings.** `/recordings` has a "Delete all" button: a confirmation names the
  count and says transcripts and summaries stay, then every recording is deleted one by one through
  `DELETE /recordings/<id>` with progress shown. A recording whose meeting hasn't ended is skipped
  and reported, and one failure never stops the rest.
