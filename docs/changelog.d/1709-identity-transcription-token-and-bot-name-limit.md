- **A customer transcription token never reaches the platform's endpoint.** With no URL of their
  own, a bot now gets the platform's transcription URL *and* its token. A leftover token used to win
  over the platform's own, so the platform service was called with a credential it never issued.
  `PUT /user/transcription {"url": ""}` now clears the saved token as well.
- **One bot-name limit: 100 characters.** Every writer of the default bot name (`PUT /user/calendar`,
  calendar connections, and the settings the agent's tools write) keeps the same limit. The agent's
  path used to cut names to 64 characters. The dashboard's first-run and transcription settings
  forms now accept up to 100.
