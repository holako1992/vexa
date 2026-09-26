# meeting_api.sweeps — background sweep bodies + their single-flight guard (#637, DB-78)

At `meetingApi.replicaCount > 1` every meeting-api replica starts the same background loops, so each
sweep's real work runs once **per replica** instead of once per interval. This package makes that
safety structural rather than accidental, and holds the one sweep body (retention) whose selection
logic is worth testing on its own rather than only inline in `__main__.py`.

## Files

- **`single_flight.py`** — the guard itself: wraps a sweep tick in a Postgres **session-level
  advisory lock** keyed by loop name (a fixed `classid` disjoint from the per-user
  `pg_advisory_xact_lock` keyspace). The replica that acquires the lock runs the tick, the others
  skip it that interval. A replica that dies mid-tick drops its session lock on disconnect, so the
  next interval is picked up elsewhere — no leader-election infra. It **degrades to run-the-tick**
  when no DB session factory is available (single-replica / Lite), so single-replica behaviour is
  unchanged. The `segment-consumer` loop is deliberately **not** wrapped — it is already
  single-delivery via the Redis consumer group, and wrapping it would serialize the replicas'
  stream reads. This is the mistake it exists to prevent: a sweep that both LISTS and DELETES,
  unguarded, pays the listing cost twice per replica and can race two deletes of the same object.
- **`retention.py`** (DB-78) — the Free-plan recording retention purge: `run_retention_sweep`
  selects the oldest bounded batch of candidate recordings, resolves each distinct owner's CURRENT
  plan through the existing `bot-context` edge (cached once per owner per tick), and deletes a
  genuinely Free, genuinely past-retention recording through the same owner-scoped
  `recordings.deletion.delete_owned_recording` a person's own `DELETE /recordings/{id}` uses.
  `fetch_free_plan_retention_days` / `fetch_user_plan_id` are its two admin-api reads — the first
  ONE PER TICK (a deployment-wide catalog constant), the second bounded per distinct owner in the
  batch. `__main__._retention_sweep_loop` wires it behind `RETENTION_SWEEP_ENABLED` (off by
  default) and the same `_guarded` single-flight every other loop here uses. This is the mistake
  it exists to prevent: a sweep that resolves a whole user's entitlements (or hardcodes "7") to
  answer a question every Free user shares the same answer to.
