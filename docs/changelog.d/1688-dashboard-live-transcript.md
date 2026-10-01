- **Live transcripts stream on the dashboard's meeting page (#1688).** While a meeting is live, the
  page reads its transcript from the agent's live feed (`GET /agent/meeting/stream`) through the
  dashboard's own allowlisted proxy instead of re-reading it every 5 seconds; a reconnect resumes
  from the last line received (`Last-Event-ID`), and the page falls back to the 5-second refresh
  whenever the feed is unavailable, for example on a deployment without the agent domain. The page
  follows the newest line while you are at the bottom; scroll up to read and a **Jump to live**
  button brings you back. Proven against a stub of the gateway in the feed's own shape, not yet
  against a live meeting.
