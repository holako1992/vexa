- **The dashboard plays, downloads and deletes recordings (#1680).** A new **Recordings** page
  lists every recording with Download and Delete (confirmed, with a toast). A meeting page with a
  recording gets an audio player; clicking a transcript line seeks the audio there and the line
  being spoken is highlighted. Audio streams through the dashboard's closed allowlist: only the
  browser's `Range` header is forwarded, `206`/`Content-Range` come back intact, the body is
  streamed rather than buffered, and a non-audio/video upstream type is served as an opaque
  download so it can never render on the dashboard's origin. Every plan gets the same controls;
  the page shows the plan's retention period.
