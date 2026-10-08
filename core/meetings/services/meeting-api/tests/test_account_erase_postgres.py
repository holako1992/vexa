"""Account erasure against a REAL Postgres — the SQL the in-memory fake never runs.

Set ``MEETING_API_TEST_DATABASE_URL`` (``postgresql+asyncpg://…``) to run. The test creates its own
tables in a scratch schema-less database, so point it at a throwaway one.
"""
from __future__ import annotations

import os

import httpx
import pytest

from meeting_api import create_app
from meeting_api.account_erase.adapters import SqlAlchemyAccountEraseRepo
from meeting_api.account_erase.fakes import in_memory_redis

pytestmark = pytest.mark.skipif(
    not os.getenv("MEETING_API_TEST_DATABASE_URL"),
    reason="real-Postgres erasure; set MEETING_API_TEST_DATABASE_URL to run",
)

SECRET = "pg-erase-secret"
A, B = 7, 8

_EVENT_TIME_FN = """
CREATE OR REPLACE FUNCTION meeting_event_time(data jsonb, start_time timestamp, created_at timestamp)
RETURNS timestamp LANGUAGE sql IMMUTABLE AS
$$ SELECT COALESCE(((data ->> 'scheduled_at')::timestamptz AT TIME ZONE 'UTC'), start_time, created_at) $$
"""


@pytest.fixture
async def session_factory(monkeypatch):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from meeting_api.sessions.models import Base

    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    engine = create_async_engine(os.environ["MEETING_API_TEST_DATABASE_URL"])
    async with engine.begin() as conn:
        await conn.execute(text(_EVENT_TIME_FN))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


async def _seed(sf):
    from meeting_api.sessions.models import Meeting, MeetingSession, Transcription

    async with sf() as db:
        rows = [
            Meeting(id=101, user_id=A, platform="zoom", platform_specific_id="a1", status="completed",
                    data={"recordings": [], "transcript_viewers": [B]}),
            Meeting(id=102, user_id=A, platform="zoom", platform_specific_id="a2", status="scheduled",
                    data={}),
            Meeting(id=201, user_id=B, platform="zoom", platform_specific_id="b1", status="completed",
                    data={"transcript_viewers": [A, 9]}),
            Meeting(id=202, user_id=B, platform="zoom", platform_specific_id="b2", status="completed",
                    data={"transcript_viewers": [9]}),
        ]
        db.add_all(rows)
        await db.flush()
        db.add_all([
            Transcription(meeting_id=101, start_time=0, end_time=1, text="a", segment_id="1"),
            Transcription(meeting_id=101, start_time=1, end_time=2, text="b", segment_id="2"),
            Transcription(meeting_id=201, start_time=0, end_time=1, text="c", segment_id="1"),
            MeetingSession(meeting_id=101, session_uid="s-a"),
            MeetingSession(meeting_id=201, session_uid="s-b"),
        ])
        await db.commit()


async def _counts(sf) -> dict:
    from sqlalchemy import func, select

    from meeting_api.sessions.models import Meeting, MeetingSession, Transcription

    async with sf() as db:
        return {
            "a_meetings": (await db.execute(select(func.count()).select_from(Meeting).where(Meeting.user_id == A))).scalar(),
            "b_meetings": (await db.execute(select(func.count()).select_from(Meeting).where(Meeting.user_id == B))).scalar(),
            "transcriptions": (await db.execute(select(func.count()).select_from(Transcription))).scalar(),
            "sessions": (await db.execute(select(func.count()).select_from(MeetingSession))).scalar(),
        }


async def test_sql_adapter_erases_a_and_leaves_b(session_factory):
    from sqlalchemy import select

    from meeting_api.sessions.models import Meeting

    await _seed(session_factory)
    app = create_app(account_erase_repo=SqlAlchemyAccountEraseRepo(session_factory),
                     account_erase_redis=in_memory_redis())
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        first = await client.post(f"/internal/accounts/{A}/erase", headers={"X-Internal-Secret": SECRET})
        second = await client.post(f"/internal/accounts/{A}/erase", headers={"X-Internal-Secret": SECRET})

    assert first.status_code == 200, first.text
    assert first.json()["erased"] == {
        "meetings": 2, "transcriptions": 2, "sessions": 1, "recordings": 0, "recording_objects": 0,
        "bots_stopped": 0, "viewer_grants_removed": 1, "streams": 0,
    }
    assert set(second.json()["erased"].values()) == {0}
    assert await _counts(session_factory) == {
        "a_meetings": 0, "b_meetings": 2, "transcriptions": 1, "sessions": 1}
    async with session_factory() as db:
        viewers = {m.id: m.data.get("transcript_viewers") for m in
                   (await db.execute(select(Meeting).where(Meeting.user_id == B))).scalars()}
    assert viewers == {201: [9], 202: [9]}
