- **Dashboard: bot dispatch and ICS calendar auto-join (#1632).** The Meetings view gains an
  "Add Bot" action — paste a Google Meet, Zoom, Teams, or Jitsi link and Vexa joins it — plus a
  Calendar tab to connect an ICS feed for automatic join, with per-calendar sync, auto-join
  toggle, and disconnect. Both ride the same server-side proxy as the existing read paths: the
  API key never reaches the browser, and the write surface is a closed allowlist (`POST /bots`,
  `POST`/`PATCH`/`DELETE /user/calendars`, `POST /user/calendars/<id>/sync`) with no overlap onto
  reads. See [`clients/dashboard/README.md`](https://github.com/Vexa-ai/vexa/blob/main/clients/dashboard/README.md).
