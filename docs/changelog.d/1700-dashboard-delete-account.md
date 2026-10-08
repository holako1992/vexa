- **Delete your account from the dashboard.** `/settings/account` has a Delete account section that
  lists what is erased (meetings, transcripts, recordings, summaries and notes, calendar
  connections, API keys, chat history) and says a paid subscription is cancelled immediately with
  no refund. Deleting asks you to type your account's email; the server checks it again. On success
  every session is signed out and you land on the sign-in page with a notice; signing in again with
  the same address starts a new, empty account. If the deletion cannot be completed in full, the
  page says so in plain words instead of claiming success. Exercised against the end-to-end stub of
  the account service; the core's `DELETE /admin/users/{id}` is what does the erasing.
