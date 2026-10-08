"""Account erasure: stop the bots, remove the objects, the cache keys, the shares, then the rows.

Each stage is idempotent and the rows go last, so an interrupted run leaves the account fully
discoverable and the retry finishes it. See the package README for the stage order.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from ..bot_spawn.ports import WorkloadUnknown
from ..collector.db_writer import ACTIVE_MEETINGS_KEY, PROC_PENDING_KEY, proc_stream_key, segments_hash_key
from ..lifecycle.stop import leave_command_channel, leave_command_payload
from ..obs import log_event
from ..recordings.deletion import delete_recording_objects
from ..recordings.jsonb import SIGNAL_ROOT_PREFIX
from ..webhooks.retry import DEAD_LETTER_KEY, PROCESSING_KEY, RETRY_QUEUE_KEY
from .ports import AccountEraseRepo

_TERMINAL = frozenset({"completed", "failed"})
_PLANNED = frozenset({"scheduled", "idle"})

#: Re-listing passes while bots are being stopped: a spawn that raced the first listing writes its
#: row or workload id after it, so each pass picks up what the previous one could not see.
_STOP_PASSES = 3


class EraseFailed(Exception):
    """A stage could not finish; nothing past it was attempted and the retry resumes there."""

    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage
        self.message = message


def _text(value: Any) -> str:
    return value.decode() if isinstance(value, (bytes, bytearray)) else str(value)


def transcript_stream_key(meeting_id: int) -> str:
    return f"tc:meeting:{meeting_id}"


class AccountEraser:
    def __init__(self, *, repo: AccountEraseRepo, storage: Any, runtime: Any, publisher: Any,
                 redis: Any):
        self._repo = repo
        self._storage = storage
        self._runtime = runtime
        self._publisher = publisher
        self._redis = redis

    async def erase(self, user_id: int) -> dict:
        erased = {"meetings": 0, "transcriptions": 0, "sessions": 0, "recordings": 0,
                  "recording_objects": 0, "bots_stopped": 0, "viewer_grants_removed": 0,
                  "streams": 0}

        meetings = await self._stage("bots", self._stop_bots, user_id, erased)
        await self._stage("recordings", self._erase_objects, user_id, meetings, erased)
        await self._stage("redis", self._erase_redis, user_id, meetings, erased)
        await self._stage("shares", self._remove_shares, user_id, erased)
        await self._stage("rows", self._delete_rows, user_id, meetings, erased)
        # A dying bot can write a segment between the cache pass and the row delete; the ids are
        # known here, so sweep the per-meeting keys once more. Not counted: it is the same data.
        await self._stage("redis", self._sweep_meeting_keys, meetings)

        log_event("account_erased", audience="operator", span="accounts.erase",
                  user_id=user_id, fields=erased)
        return {"user_id": user_id, "erased": erased}

    async def _stage(self, stage: str, fn, *args):
        try:
            return await fn(*args)
        except EraseFailed:
            raise
        except Exception as e:  # noqa: BLE001 — surfaced as a 5xx naming the stage; retry resumes
            log_event("account_erase_failed", audience="operator", level="error",
                      span="accounts.erase", fields={"stage": stage, "error": str(e)})
            raise EraseFailed(stage, str(e) or type(e).__name__) from e

    # -- bots ------------------------------------------------------------------------------

    async def _stop_bots(self, user_id: int, erased: dict) -> list[dict]:
        """Delete planned rows, stop every live bot, return the final listing."""
        stopped_rows: set[int] = set()
        handled: set[tuple[int, Optional[str]]] = set()
        meetings = await self._repo.list_meetings(user_id)
        for _ in range(_STOP_PASSES):
            planned = [m for m in meetings if m["status"] in _PLANNED]
            live = [m for m in meetings
                    if m["status"] not in _TERMINAL and m["status"] not in _PLANNED
                    and (m["id"], m.get("bot_container_id")) not in handled]
            if not planned and not live:
                break
            if planned:
                removed = await self._repo.delete_meetings(user_id, [m["id"] for m in planned])
                for key, n in removed.items():
                    erased[key] += n
            if live:
                await self._repo.mark_stop_requested(user_id, [m["id"] for m in live])
                for m in live:
                    if await self._stop_one(m):
                        stopped_rows.add(m["id"])
                    handled.add((m["id"], m.get("bot_container_id")))
            meetings = await self._repo.list_meetings(user_id)
        erased["bots_stopped"] = len(stopped_rows)
        return meetings

    async def _stop_one(self, meeting: dict) -> bool:
        """Ask the bot to leave and delete its workload. True once either reached the bot."""
        mid = meeting["id"]
        left = False
        try:
            await self._publisher.publish(
                leave_command_channel(mid), json.dumps(leave_command_payload(mid)))
            left = True
        except Exception:  # noqa: BLE001 — the workload teardown below is the guarantee
            pass
        container = meeting.get("bot_container_id")
        if not container:
            if not left:
                raise EraseFailed("bots", f"meeting {mid}: no workload to delete and the "
                                          "leave command could not be published")
            return True
        try:
            await self._runtime.delete_workload(container)
        except WorkloadUnknown:
            log_event("account_erase_workload_unconfirmed", audience="operator", level="warning",
                      span="accounts.erase", meeting_id=str(mid), fields={"workload_id": container})
            return left
        except Exception as e:  # noqa: BLE001
            raise EraseFailed("bots", f"meeting {mid}: workload {container} could not be "
                                      f"deleted: {e}") from e
        return True

    # -- objects ---------------------------------------------------------------------------

    async def _erase_objects(self, user_id: int, meetings: list[dict], erased: dict) -> None:
        deleted: set[str] = set()
        recordings = 0
        for m in meetings:
            for rec in (m["data"].get("recordings") or []):
                if not isinstance(rec, dict):
                    continue
                recordings += 1
                owned = {**rec, "user_id": user_id, "meeting_id": m["id"]}
                deleted.update(await delete_recording_objects(self._storage, owned))
        # Whatever the rows no longer name: orphaned chunks, masters, captured-signal tapes.
        for prefix in (f"recordings/{user_id}/", f"{SIGNAL_ROOT_PREFIX}{user_id}/"):
            for key in await self._storage.list(prefix):
                await self._storage.delete(key)
                deleted.add(key)
        erased["recordings"] = recordings
        erased["recording_objects"] = len(deleted)

    # -- redis -----------------------------------------------------------------------------

    async def _erase_redis(self, user_id: int, meetings: list[dict], erased: dict) -> None:
        count = await self._sweep_meeting_keys(meetings)
        keys = [f"cal:sync:{user_id}", f"webhook:deliveries:{user_id}"]
        async for key in self._redis.scan_iter(match=f"cal:sync:{user_id}:*"):
            keys.append(_text(key))
        count += int(await self._redis.delete(*keys))
        await self._prune_webhook_queues(user_id)
        erased["streams"] = count

    async def _sweep_meeting_keys(self, meetings: list[dict]) -> int:
        keys: list[str] = []
        for m in meetings:
            keys += [transcript_stream_key(m["id"]), proc_stream_key(m["id"]),
                     segments_hash_key(m["id"])]
        count = int(await self._redis.delete(*keys)) if keys else 0
        for m in meetings:
            await self._redis.srem(ACTIVE_MEETINGS_KEY, str(m["id"]))
            await self._redis.zrem(PROC_PENDING_KEY, str(m["id"]))
        return count

    async def _prune_webhook_queues(self, user_id: int) -> None:
        """Drop queued / dead-lettered deliveries whose meeting block belongs to the user — they
        carry the user's meeting data and webhook secret."""
        for key in (RETRY_QUEUE_KEY, PROCESSING_KEY, DEAD_LETTER_KEY):
            for raw in await self._redis.lrange(key, 0, -1):
                try:
                    entry = json.loads(raw)
                    owner = ((entry.get("payload") or {}).get("data") or {}).get("meeting", {}).get("user_id")
                except (TypeError, ValueError, AttributeError):
                    continue
                if owner == user_id:
                    await self._redis.lrem(key, 1, raw)

    # -- shares and rows -------------------------------------------------------------------

    async def _remove_shares(self, user_id: int, erased: dict) -> None:
        erased["viewer_grants_removed"] = await self._repo.remove_viewer(user_id)

    async def _delete_rows(self, user_id: int, meetings: list[dict], erased: dict) -> None:
        removed = await self._repo.delete_meetings(user_id, [m["id"] for m in meetings])
        for key, n in removed.items():
            erased[key] += n
        leftover = await self._repo.list_meetings(user_id)
        if leftover:
            raise EraseFailed("rows", f"{len(leftover)} meeting(s) appeared during erasure; "
                                      "retry to finish")
