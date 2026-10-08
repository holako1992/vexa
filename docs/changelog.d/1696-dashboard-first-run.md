- **First-run welcome in the dashboard (#1696).** A new account with no meetings sees a three-step
  welcome after signing in: name the bot, connect Google Calendar or Microsoft 365, then paste a
  meeting link and send the bot — the plan's meeting allowance is stated before anything is pasted,
  and a spent or unverified allowance is explained in words with connecting a calendar still on
  offer. Every step has **Skip setup**; sending the first bot ends the welcome. The bot's name is
  saved as the account's default bot name (`bot_name` on `PUT /user/calendar`, the name every bot
  sent without one of its own uses). Where the person is lives on the account, so a refresh or
  another browser resumes the same step, and coming back from the calendar consent screen continues
  the welcome. Accounts that are not new, and accounts that already have meetings, are never
  welcomed. **New in core:** `GET` / `PUT /user/first-run` (identity; `bot` or `tx` scope) hold the
  position and the done/skipped decision — see [Settings API](/api/settings#first-run-welcome).
