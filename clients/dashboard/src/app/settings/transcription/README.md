# `src/app/settings/transcription/` — the transcription settings page

- `page.tsx` resolves the signed-in user (redirecting to `/login` when there is none) and renders
  the view inside `Shell`.
- `TranscriptionSettingsView.tsx` is the view. It lives beside its page rather than in
  `src/components/` because nothing else renders it.

The page edits two stores the core owns, each where the core keeps it, never a copy:

- **Bot name** — the account's default bot name, `users.data.calendar_bot_name`, through
  `GET/PUT /user/calendar {bot_name}`. It is the same field the first-run welcome writes and the
  one `POST /bots` and calendar auto-join fall back to, so a name saved here is the name the next
  bot joins as. A second "bot name" store would let the two disagree; that is the mistake this
  page is built not to make.
- **Transcription service** — `GET/PUT /user/transcription {url, token}`: this Vexa's own service
  (`url: null`), or the person's own OpenAI-compatible endpoint. The token is write-only: the page
  says whether one is saved and never shows or prefills it. A token always travels with its URL,
  and "Use this Vexa's service" clears both, so a customer token is never sent to a backend it was
  not given for (`lib/transcriptionSettings.ts`).

Language is stated, not set: the core takes it per bot (`language` on `POST /bots`) and otherwise
detects it. There is no account-wide default language or transcription model in the core to edit.

A failed read of either store shows "could not ask" with a retry, never a default value; every save
confirms or fails through a toast.
