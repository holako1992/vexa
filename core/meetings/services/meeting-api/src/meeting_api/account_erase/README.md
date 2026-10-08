# account_erase — the meetings domain's account erasure

`POST /internal/accounts/{user_id}/erase` removes everything meeting-api holds for one account.
Identity (admin-api) orchestrates the deletion: it locks the account, calls this endpoint, then
deletes the `users` row. The route is service-to-service only — `X-Internal-Secret` must equal
`INTERNAL_API_SECRET` (unset secret: 503, wrong or missing: 403) and the gateway has no route to it.

## Front door
- `build_router(eraser)` — the mountable route (the unified app mounts it).
- `AccountEraser(repo, storage, runtime, publisher, redis)` — `await eraser.erase(user_id)` returns
  the response body; raises `EraseFailed(stage, message)` when a stage fails.
- `AccountEraseRepo` port; `adapters.SqlAlchemyAccountEraseRepo` (Postgres); `fakes` (in-memory).

## What goes, in order
1. **Planned rows** (`scheduled` / `idle`) are deleted first so no auto-join can dispatch them.
2. **Bots**: every other non-terminal row is flagged `stop_requested`, sent the `leave` command and
   has its workload deleted. The rows are re-listed (up to three passes) so a spawn that raced the
   first listing is caught. A runtime that no longer knows a workload (404) is logged and does not
   block; any other runtime error fails the stage.
3. **Objects**: each recording is deleted through `recordings.deletion`, then the whole
   `recordings/{user_id}/` and `signal/{user_id}/` prefixes are swept (leftover chunks, captured
   signal tapes).
4. **Redis**: per meeting `tc:meeting:{id}`, `proc:meeting:{id}`, `meeting:{id}:segments`, plus the
   `active_meetings` / `processed_pending` memberships; per user `cal:sync:{id}*` and
   `webhook:deliveries:{id}`; webhook retry / processing / dead-letter entries whose meeting block
   names the user.
5. **Shares**: the user's id is removed from `data.transcript_viewers` on other users' meetings.
6. **Rows**: `transcriptions`, `meeting_sessions`, `meetings` in one transaction. Recordings, notes
   and processed transcripts live in `meetings.data`, so they leave with the row.

Objects are erased before the rows that point at them, and the rows go last, so a failure at any
stage leaves the account discoverable and a retry finishes the work. Counts in the response describe
what the call itself removed; erasing an erased account returns zeros.

## Usage records
Usage (meetings started, minutes) is computed from `meetings` rows — there is no meter table — so
erasing the rows erases the usage history. Nothing billing-related is kept in this domain.
