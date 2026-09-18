- **Dashboard: the meeting detail page reads one row, not the whole list (#1636).** Opening a
  meeting, and its 5-second live poll, now call `GET /meetings/<id>` instead of fetching every
  meeting on the account to find one by client-side `.find()`. A meeting that is not yours (or
  no longer exists) renders the existing not-found state from the gateway's 404; a backend outage
  or network failure renders the error state with retry instead of an empty list, so "we could
  not ask" is never shown as "you have none."
