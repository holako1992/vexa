"""In-memory ``AccountEraseRepo`` and redis for the offline harness."""
from __future__ import annotations

from typing import Optional


class InMemoryAccountEraseRepo:
    """Dict-backed meetings, transcriptions and sessions, shaped like the SQL rows."""

    def __init__(self) -> None:
        self.meetings: dict[int, dict] = {}
        self.transcriptions: list[dict] = []
        self.sessions: list[dict] = []

    def add_meeting(self, *, id: int, user_id: int, status: str = "completed",
                    bot_container_id: Optional[str] = None, data: Optional[dict] = None) -> dict:
        row = {"id": id, "user_id": user_id, "status": status,
               "bot_container_id": bot_container_id, "data": dict(data or {})}
        self.meetings[id] = row
        return row

    async def list_meetings(self, user_id: int) -> list[dict]:
        return [
            {"id": m["id"], "status": m["status"], "bot_container_id": m["bot_container_id"],
             "data": dict(m["data"])}
            for m in self.meetings.values() if m["user_id"] == user_id
        ]

    async def mark_stop_requested(self, user_id: int, meeting_ids: list[int]) -> None:
        for mid in meeting_ids:
            m = self.meetings.get(mid)
            if m is not None and m["user_id"] == user_id:
                m["data"]["stop_requested"] = True

    async def delete_meetings(self, user_id: int, meeting_ids: list[int]) -> dict:
        ids = {mid for mid in meeting_ids
               if mid in self.meetings and self.meetings[mid]["user_id"] == user_id}
        tx = [t for t in self.transcriptions if t["meeting_id"] in ids]
        ss = [s for s in self.sessions if s["meeting_id"] in ids]
        self.transcriptions = [t for t in self.transcriptions if t["meeting_id"] not in ids]
        self.sessions = [s for s in self.sessions if s["meeting_id"] not in ids]
        for mid in ids:
            del self.meetings[mid]
        return {"meetings": len(ids), "transcriptions": len(tx), "sessions": len(ss)}

    async def remove_viewer(self, user_id: int) -> int:
        changed = 0
        for m in self.meetings.values():
            viewers = m["data"].get("transcript_viewers")
            if m["user_id"] != user_id and isinstance(viewers, list) and user_id in viewers:
                m["data"]["transcript_viewers"] = [v for v in viewers if v != user_id]
                changed += 1
        return changed


def in_memory_redis():
    """A fakeredis client — the app-factory default for the redis keys erasure touches."""
    import fakeredis.aioredis

    return fakeredis.aioredis.FakeRedis()
