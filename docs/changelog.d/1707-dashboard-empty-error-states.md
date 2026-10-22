- **Dashboard empty and error states name the next step.** Every empty list, tab and panel says
  what is missing and offers the action that fills it (send a bot, connect a calendar, search
  everything, back to your meetings). A failed read is shown as a failure with a retry, never as
  "none": meeting participants, the audio player, the plan on `/billing`, the Add Bot dialog's
  calendar list, and "Sync now" on Upcoming, which no longer reports an unreadable calendar list as
  "No calendars connected". A failed "Load more" keeps the meetings or recordings already shown and
  says so in a toast; adding or removing a tag and a failed transcript copy now toast too.
