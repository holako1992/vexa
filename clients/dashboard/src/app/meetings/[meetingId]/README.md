# `src/app/meetings/[meetingId]/` — one meeting

Resolves the signed-in user, then renders `components/MeetingDetail` for this row id. The read
behind it is owner-scoped at the gateway, so an id belonging to someone else returns nothing to
render rather than someone else's transcript.
