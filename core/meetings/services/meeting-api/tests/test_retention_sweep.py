"""DB-78 — the Free-plan recording retention sweep (`meeting_api.sweeps.retention`).

Drives ``run_retention_sweep`` over the SAME in-memory fakes ``test_recordings.py`` uses
(``InMemoryRecordingRepo`` / ``InMemoryStorage``), offline — no MinIO, no DB. The four properties
this file holds, matching DB-78's own acceptance list:

  1. only Free-plan owners are purged — a Pro owner's equally-old recording is left alone;
  2. only recordings older than the (catalog-read, never-hardcoded-here) retention are purged;
  3. the batch is bound — more candidates than the limit still costs at most `batch_limit` deletes
     in one tick;
  4. deletion goes through the SAME owner-scoped path `DELETE /recordings/{id}` uses
     (`delete_owned_recording`): storage objects are actually removed and the JSONB row drops the
     recording — never a raw row delete that would orphan objects.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage
from meeting_api.sweeps.retention import run_retention_sweep

NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)
RETENTION_DAYS = 7
OLD_ISO = (NOW - timedelta(days=10)).isoformat()
RECENT_ISO = (NOW - timedelta(days=1)).isoformat()


def _seed_recording(repo, *, meeting_id, user_id, recording_id, created_at, storage=None,
                    storage_key=None):
    session_uid = f"sess-{meeting_id}"
    repo.seed(meeting_id=meeting_id, user_id=user_id, session_uid=session_uid,
             status="completed", created_at=created_at)
    recording = {
        "id": recording_id, "user_id": user_id, "session_uid": session_uid,
        "created_at": created_at, "status": "complete",
    }
    if storage is not None and storage_key is not None:
        asyncio.run(storage.upload(storage_key, b"bytes", content_type="audio/wav"))
        recording["media_files"] = [{"storage_path": storage_key}]
    asyncio.run(repo.mutate_recordings(meeting_id, lambda cur: (cur + [recording], None)))


def _plan_lookup_from(plans: dict):
    async def _lookup(user_id: int):
        return plans.get(user_id)
    return _lookup


# ── 1 · only Free-plan owners are purged ────────────────────────────────────────────────────────
def test_only_free_plan_owners_are_purged():
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    _seed_recording(repo, meeting_id=1, user_id=100, recording_id="r-free", created_at=OLD_ISO,
                    storage=storage, storage_key="recordings/100/1/sess-1/master.wav")
    _seed_recording(repo, meeting_id=2, user_id=200, recording_id="r-pro", created_at=OLD_ISO,
                    storage=storage, storage_key="recordings/200/2/sess-2/master.wav")

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_plan_lookup_from({100: "free", 200: "pro"}),
        retention_days=RETENTION_DAYS, now=NOW,
    ))

    assert out["deleted"] == 1
    assert out["skipped_not_free"] == 1
    assert asyncio.run(repo.get_recordings(1)) == []
    pro_recordings = asyncio.run(repo.get_recordings(2))
    assert len(pro_recordings) == 1 and pro_recordings[0]["id"] == "r-pro"


# ── 2 · only recordings older than the retention ceiling are purged ────────────────────────────
def test_only_older_than_retention_is_purged():
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    _seed_recording(repo, meeting_id=1, user_id=100, recording_id="r-old", created_at=OLD_ISO)
    _seed_recording(repo, meeting_id=2, user_id=100, recording_id="r-new", created_at=RECENT_ISO)

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_plan_lookup_from({100: "free"}),
        retention_days=RETENTION_DAYS, now=NOW,
    ))

    assert out["deleted"] == 1
    assert asyncio.run(repo.get_recordings(1)) == []
    recent = asyncio.run(repo.get_recordings(2))
    assert len(recent) == 1 and recent[0]["id"] == "r-new"


def test_a_different_retention_value_changes_the_cutoff_with_no_hardcoded_number():
    """The sweep never hardcodes "7" — it is a caller-supplied parameter, read by the loop from
    `fetch_free_plan_retention_days` at tick time. A 30-day retention leaves a 10-day-old
    recording untouched even though it would have been purged at 7."""
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    _seed_recording(repo, meeting_id=1, user_id=100, recording_id="r-old", created_at=OLD_ISO)

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_plan_lookup_from({100: "free"}),
        retention_days=30, now=NOW,
    ))

    assert out["deleted"] == 0
    assert len(asyncio.run(repo.get_recordings(1))) == 1


# ── 3 · the batch is bound ───────────────────────────────────────────────────────────────────────
def test_batch_limit_bounds_one_tick():
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    for i in range(5):
        _seed_recording(repo, meeting_id=i, user_id=100, recording_id=f"r-{i}",
                        created_at=OLD_ISO)

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_plan_lookup_from({100: "free"}),
        retention_days=RETENTION_DAYS, now=NOW, batch_limit=2,
    ))

    assert out["scanned"] == 2
    assert out["deleted"] == 2
    remaining = sum(len(asyncio.run(repo.get_recordings(i))) for i in range(5))
    assert remaining == 3, "only the batch-limited pair was purged this tick"


# ── 4 · deletion goes through the proper owner-scoped path ──────────────────────────────────────
def test_deletion_goes_through_delete_owned_recording_not_a_raw_row_delete():
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    key = "recordings/100/1/sess-1/master.wav"
    _seed_recording(repo, meeting_id=1, user_id=100, recording_id="r-free", created_at=OLD_ISO,
                    storage=storage, storage_key=key)
    assert asyncio.run(storage.exists(key)) is True

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_plan_lookup_from({100: "free"}),
        retention_days=RETENTION_DAYS, now=NOW,
    ))

    assert out["deleted"] == 1
    # the storage OBJECT was actually removed (a raw row delete would leave it orphaned) ...
    assert asyncio.run(storage.exists(key)) is False
    assert key in storage.deleted
    # ... and the JSONB row no longer carries the recording.
    assert asyncio.run(repo.get_recordings(1)) == []


def test_plan_lookup_is_cached_per_owner_within_one_tick():
    """Bounded per DISTINCT owner, not per candidate recording — two old recordings for the SAME
    Free user cost one `plan_lookup` call, not two."""
    repo = InMemoryRecordingRepo()
    storage = InMemoryStorage()
    _seed_recording(repo, meeting_id=1, user_id=100, recording_id="r-1", created_at=OLD_ISO)
    _seed_recording(repo, meeting_id=2, user_id=100, recording_id="r-2", created_at=OLD_ISO)
    calls: list[int] = []

    async def _lookup(user_id: int):
        calls.append(user_id)
        return "free"

    out = asyncio.run(run_retention_sweep(
        repo, storage, plan_lookup=_lookup, retention_days=RETENTION_DAYS, now=NOW,
    ))

    assert out["deleted"] == 2
    assert calls == [100]
