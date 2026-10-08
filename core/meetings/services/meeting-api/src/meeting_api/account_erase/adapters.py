"""``AccountEraseRepo`` over a SQLAlchemy-async ``session_factory`` (``meetings`` /
``transcriptions`` / ``meeting_sessions``)."""
from __future__ import annotations


class SqlAlchemyAccountEraseRepo:
    def __init__(self, session_factory):
        self._session_factory = session_factory

    async def list_meetings(self, user_id: int) -> list[dict]:
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            rows = (await db.execute(
                select(Meeting.id, Meeting.status, Meeting.bot_container_id, Meeting.data)
                .where(Meeting.user_id == user_id).order_by(Meeting.id)
            )).all()
        return [
            {"id": r.id, "status": r.status, "bot_container_id": r.bot_container_id,
             "data": dict(r.data) if isinstance(r.data, dict) else {}}
            for r in rows
        ]

    async def mark_stop_requested(self, user_id: int, meeting_ids: list[int]) -> None:
        if not meeting_ids:
            return
        from sqlalchemy import select
        from sqlalchemy.orm.attributes import flag_modified

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meetings = (await db.execute(
                select(Meeting).where(Meeting.user_id == user_id, Meeting.id.in_(meeting_ids))
                .with_for_update()
            )).scalars().all()
            for m in meetings:
                m.data = {**(m.data if isinstance(m.data, dict) else {}), "stop_requested": True}
                flag_modified(m, "data")
            await db.commit()

    async def delete_meetings(self, user_id: int, meeting_ids: list[int]) -> dict:
        if not meeting_ids:
            return {"meetings": 0, "transcriptions": 0, "sessions": 0}
        from sqlalchemy import delete, select

        from ..sessions.models import Meeting, MeetingSession, Transcription

        async with self._session_factory() as db:
            owned = [mid for (mid,) in (await db.execute(
                select(Meeting.id).where(Meeting.user_id == user_id, Meeting.id.in_(meeting_ids))
                .with_for_update()
            )).all()]
            if not owned:
                return {"meetings": 0, "transcriptions": 0, "sessions": 0}
            tx = await db.execute(delete(Transcription).where(Transcription.meeting_id.in_(owned)))
            ss = await db.execute(delete(MeetingSession).where(MeetingSession.meeting_id.in_(owned)))
            mm = await db.execute(delete(Meeting).where(Meeting.id.in_(owned)))
            await db.commit()
        return {"meetings": mm.rowcount, "transcriptions": tx.rowcount, "sessions": ss.rowcount}

    async def remove_viewer(self, user_id: int) -> int:
        from sqlalchemy import cast, func, select
        from sqlalchemy.dialects.postgresql import JSONB
        from sqlalchemy.orm.attributes import flag_modified

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meetings = (await db.execute(
                select(Meeting).where(
                    Meeting.user_id != user_id,
                    cast(Meeting.data["transcript_viewers"], JSONB).op("@>")(func.to_jsonb(user_id)),
                ).with_for_update()
            )).scalars().all()
            for m in meetings:
                data = dict(m.data)
                data["transcript_viewers"] = [v for v in data.get("transcript_viewers", [])
                                              if v != user_id]
                m.data = data
                flag_modified(m, "data")
            await db.commit()
        return len(meetings)
