"""Account erasure (POST /internal/accounts/{user_id}/erase) — in-process, every port an in-memory fake.

User A (7) is erased; user B (8) shares a meeting with A and owns recordings of his own. The
assertions are the contract: A's rows, objects, cache keys and shares are gone, B's are untouched, a
second call counts nothing, a storage or runtime failure is a 5xx naming the stage with the rows still
in place, and the route is closed without the internal secret.
"""
from __future__ import annotations

import json

import httpx
import pytest

from meeting_api import create_app
from meeting_api.account_erase.fakes import InMemoryAccountEraseRepo, in_memory_redis
from meeting_api.bot_spawn.fakes import FakeRuntimeClient
from meeting_api.lifecycle.stop_router import InMemoryCommandPublisher
from meeting_api.recordings.fakes import InMemoryStorage

SECRET = "erase-secret"
A, B = 7, 8
HEADERS = {"X-Internal-Secret": SECRET}


def _rec(user_id: int, rec_id: int, session_uid: str) -> dict:
    prefix = f"recordings/{user_id}/{rec_id}/{session_uid}/audio/"
    return {"id": rec_id, "session_uid": session_uid, "user_id": user_id,
            "media_files": [{"id": rec_id * 10, "type": "audio",
                             "storage_path": f"{prefix}master.wav"}]}


class World:
    """Two accounts' worth of rows, objects and redis keys."""

    def __init__(self, runtime=None, storage=None):
        self.repo = InMemoryAccountEraseRepo()
        self.storage = storage or InMemoryStorage()
        self.redis = in_memory_redis()
        self.runtime = runtime or FakeRuntimeClient()
        self.publisher = InMemoryCommandPublisher()
        self.app = create_app(
            account_erase_repo=self.repo, account_erase_redis=self.redis,
            storage=self.storage, runtime=self.runtime, command_publisher=self.publisher,
        )

    async def seed(self) -> None:
        r = self.repo
        # --- A: a finished meeting with two recordings, a shared one, a live bot, a plan -----
        r.add_meeting(id=101, user_id=A, data={
            "recordings": [_rec(A, 1, "s1"), _rec(A, 2, "s2")],
            "transcript_viewers": [B], "share_grants": [{"id": "g"}]})
        r.add_meeting(id=102, user_id=A, status="active", bot_container_id="wl-102")
        r.add_meeting(id=103, user_id=A, status="scheduled")
        r.add_meeting(id=104, user_id=A, status="failed")
        r.transcriptions += [{"meeting_id": 101}] * 3 + [{"meeting_id": 104}]
        r.sessions += [{"meeting_id": 101}, {"meeting_id": 102}, {"meeting_id": 104}]
        # --- B: his own meetings, one shared with A -------------------------------------------
        r.add_meeting(id=201, user_id=B, data={
            "recordings": [_rec(B, 5, "b1")], "transcript_viewers": [A, 9]})
        r.add_meeting(id=202, user_id=B, data={"transcript_viewers": [9]})
        r.transcriptions += [{"meeting_id": 201}] * 2
        r.sessions.append({"meeting_id": 201})

        s = self.storage
        for key in ("recordings/7/1/s1/audio/000000.wav", "recordings/7/1/s1/audio/master.wav",
                    "recordings/7/2/s2/audio/master.wav", "recordings/7/9/orphan/audio/000000.wav",
                    "signal/7/101/s1/frames.jsonl",
                    "recordings/8/5/b1/audio/master.wav", "signal/8/201/b1/frames.jsonl",
                    "recordings/77/1/x/audio/master.wav"):       # 77 shares A's id as a prefix
            await s.upload(key, b"x", content_type="application/octet-stream")

        c = self.redis
        for mid in (101, 102, 201):
            await c.xadd(f"tc:meeting:{mid}", {"k": "v"})
            await c.xadd(f"proc:meeting:{mid}", {"k": "v"})
            await c.hset(f"meeting:{mid}:segments", "s", "1")
        await c.sadd("active_meetings", "101", "201")
        await c.zadd("processed_pending", {"101": 1.0, "201": 2.0})
        for key in ("cal:sync:7", "cal:sync:7:cal1", "cal:sync:77", "cal:sync:8",
                    "webhook:deliveries:7", "webhook:deliveries:8", "webhook:deliveries:77"):
            await c.set(key, "v") if key.startswith("cal") else await c.lpush(key, "v")
        for uid in (A, B):
            entry = json.dumps({"payload": {"data": {"meeting": {"user_id": uid}}}})
            await c.rpush("webhook:retry_queue", entry)
            await c.rpush("webhook:dead_letter", entry)

    async def post(self, user_id: int = A, headers=HEADERS):
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            return await client.post(f"/internal/accounts/{user_id}/erase", headers=headers)


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)


@pytest.fixture
async def world():
    w = World()
    await w.seed()
    return w


async def _b_snapshot(w: World):
    return (
        {k: json.dumps(v, sort_keys=True) for k, v in w.repo.meetings.items() if v["user_id"] == B},
        sorted(k for k in w.storage.blobs if k.startswith(("recordings/8/", "signal/8/"))),
        [k async for k in w.redis.scan_iter(match="*meeting:201*")],
        await w.redis.lrange("webhook:deliveries:8", 0, -1),
    )


async def test_erases_everything_of_a_and_nothing_of_b(world):
    b_before = await _b_snapshot(world)
    b_viewers_before = world.repo.meetings[201]["data"]["transcript_viewers"]
    assert b_viewers_before == [A, 9]

    resp = await world.post()

    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"] == A
    # objects: 2 chunks/masters of rec 1, master of rec 2, an orphaned chunk, one signal tape;
    # streams: tc/proc/segments of meetings 101 and 102, cal:sync:7 and :cal1, webhook:deliveries:7
    assert body["erased"] == {
        "meetings": 4, "transcriptions": 4, "sessions": 3, "recordings": 2,
        "recording_objects": 5, "bots_stopped": 1, "viewer_grants_removed": 1, "streams": 9,
    }

    # A: no rows, no objects, no keys, no queue entries
    assert not [m for m in world.repo.meetings.values() if m["user_id"] == A]
    assert not [t for t in world.repo.transcriptions if t["meeting_id"] in (101, 102, 103, 104)]
    assert not [s for s in world.repo.sessions if s["meeting_id"] in (101, 102, 103, 104)]
    assert not [k for k in world.storage.blobs if k.startswith(("recordings/7/", "signal/7/"))]
    assert world.runtime.deleted == ["wl-102"]
    assert any(ch == "bot_commands:meeting:102" for ch, _ in world.publisher.published)
    for key in ("tc:meeting:101", "proc:meeting:101", "meeting:101:segments", "tc:meeting:102",
                "cal:sync:7", "cal:sync:7:cal1", "webhook:deliveries:7"):
        assert not await world.redis.exists(key), key
    assert set(await world.redis.smembers("active_meetings")) == {b"201"}
    assert [m for m, _ in await world.redis.zrange("processed_pending", 0, -1, withscores=True)] == [b"201"]
    for q in ("webhook:retry_queue", "webhook:dead_letter"):
        left = [json.loads(x)["payload"]["data"]["meeting"]["user_id"]
                for x in await world.redis.lrange(q, 0, -1)]
        assert left == [B]

    # A's id is out of B's share list (B's other viewer stays); the rest of B is byte-identical
    assert world.repo.meetings[201]["data"]["transcript_viewers"] == [9]
    b_after = await _b_snapshot(world)
    b_rows_before = {k: v for k, v in b_before[0].items()}
    assert b_after[1:] == b_before[1:]
    for mid in (201, 202):
        before = json.loads(b_rows_before[mid])
        after = world.repo.meetings[mid]
        before["data"]["transcript_viewers"] = [v for v in before["data"]["transcript_viewers"] if v != A]
        assert json.loads(json.dumps(after, sort_keys=True)) == before
    # prefix lookalikes of A's id survive
    assert await world.redis.exists("cal:sync:77") and await world.redis.exists("webhook:deliveries:77")
    assert "recordings/77/1/x/audio/master.wav" in world.storage.blobs
    assert len([t for t in world.repo.transcriptions if t["meeting_id"] == 201]) == 2


async def test_second_call_is_a_success_with_zero_counts(world):
    assert (await world.post()).status_code == 200
    resp = await world.post()
    assert resp.status_code == 200
    assert resp.json() == {"user_id": A, "erased": {
        "meetings": 0, "transcriptions": 0, "sessions": 0, "recordings": 0,
        "recording_objects": 0, "bots_stopped": 0, "viewer_grants_removed": 0, "streams": 0}}


async def test_unknown_account_is_a_zero_count_success():
    w = World()
    resp = await w.post(user_id=999)
    assert resp.status_code == 200
    assert set(resp.json()["erased"].values()) == {0}


class _FlakyStorage(InMemoryStorage):
    """delete() raises while ``broken`` — the object store going away mid-erasure."""

    broken = True

    async def delete(self, key: str) -> None:
        if self.broken and key.endswith("2/s2/audio/master.wav"):
            raise OSError("minio unavailable")
        await super().delete(key)


async def test_storage_failure_is_a_5xx_with_rows_intact_and_the_retry_completes():
    storage = _FlakyStorage()
    w = World(storage=storage)
    await w.seed()

    failed = await w.post()

    assert failed.status_code == 500
    assert failed.json()["stage"] == "recordings"
    assert "minio unavailable" in failed.json()["error"]
    # rows still address the objects that are left; nothing past the stage ran
    assert {101, 102, 104} <= set(w.repo.meetings)
    assert "recordings/7/2/s2/audio/master.wav" in storage.blobs
    assert await w.redis.exists("tc:meeting:101")
    assert w.repo.meetings[201]["data"]["transcript_viewers"] == [A, 9]

    storage.broken = False
    retried = await w.post()

    assert retried.status_code == 200
    assert retried.json()["erased"]["meetings"] == 3        # the planned row went on the first call
    assert not [m for m in w.repo.meetings.values() if m["user_id"] == A]
    assert not [k for k in storage.blobs if k.startswith(("recordings/7/", "signal/7/"))]
    assert "recordings/8/5/b1/audio/master.wav" in storage.blobs


class _BrokenRuntime(FakeRuntimeClient):
    async def delete_workload(self, workload_id: str) -> None:
        raise RuntimeError("kernel down")


async def test_runtime_failure_keeps_every_row_so_a_live_bot_is_never_orphaned():
    w = World(runtime=_BrokenRuntime())
    await w.seed()

    resp = await w.post()

    assert resp.status_code == 500
    assert resp.json()["stage"] == "bots"
    assert 102 in w.repo.meetings and 101 in w.repo.meetings
    assert w.repo.meetings[102]["data"]["stop_requested"] is True


async def test_workload_unknown_to_the_runtime_does_not_block_erasure():
    w = World(runtime=FakeRuntimeClient(workloads={}))      # the kernel tracks nothing: delete → 404
    await w.seed()

    resp = await w.post()

    assert resp.status_code == 200
    assert resp.json()["erased"]["bots_stopped"] == 1       # the leave command reached the bot's channel
    assert 102 not in w.repo.meetings


async def test_auth_fails_closed(monkeypatch, world):
    assert (await world.post(headers={})).status_code == 403
    assert (await world.post(headers={"X-Internal-Secret": "wrong"})).status_code == 403
    monkeypatch.delenv("INTERNAL_API_SECRET")
    assert (await world.post()).status_code == 503
    monkeypatch.setenv("INTERNAL_API_SECRET", "")
    assert (await world.post(headers={"X-Internal-Secret": ""})).status_code == 503
    assert 101 in world.repo.meetings and "recordings/7/1/s1/audio/master.wav" in world.storage.blobs


async def test_non_numeric_user_id_is_refused_after_auth(world):
    transport = httpx.ASGITransport(app=world.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        assert (await client.post("/internal/accounts/abc/erase", headers=HEADERS)).status_code == 422
        assert (await client.post("/internal/accounts/abc/erase")).status_code == 403
