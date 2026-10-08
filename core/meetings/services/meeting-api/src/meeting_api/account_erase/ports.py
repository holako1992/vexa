"""The meeting store as account erasure sees it — one port, SQL in production."""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class AccountEraseRepo(Protocol):
    async def list_meetings(self, user_id: int) -> list[dict]:
        """Every meeting the user owns: ``{id, status, bot_container_id, data}``."""
        ...

    async def mark_stop_requested(self, user_id: int, meeting_ids: list[int]) -> None:
        """Merge ``stop_requested`` into the owner's meetings' data — the durable intent the
        spawn interlock and the exit classifier read."""
        ...

    async def delete_meetings(self, user_id: int, meeting_ids: list[int]) -> dict:
        """Delete the owner's meetings with their transcriptions and sessions in one transaction.
        Returns ``{"meetings", "transcriptions", "sessions"}`` — rows removed by this call."""
        ...

    async def remove_viewer(self, user_id: int) -> int:
        """Drop ``user_id`` from ``data.transcript_viewers`` on every meeting someone else owns.
        Returns the number of meetings changed."""
        ...
