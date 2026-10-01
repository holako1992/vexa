- **Name the speakers in a transcript from the dashboard (#1686).** The meeting page's
  **Speakers** dialog turns "Speaker 1" into a person's name on every line and in every export.
  Names are stored on the meeting as `metadata.speaker_labels` through
  `POST /meetings/{id}/annotate`; the transcript itself is unchanged, and clearing a name shows the
  original again. See [Speaker names and tags](/api/meetings#speaker-names-and-tags-caller-annotations).
