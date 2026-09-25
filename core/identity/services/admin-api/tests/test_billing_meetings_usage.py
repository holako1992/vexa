"""DB-71 — the real `UsagePort`: `meetings_usage_for_period` counted straight from `meetings`.

Same testcontainers-PG harness as `test_stack_postgres.py` (skips without docker, no Redis —
`meetings_usage_for_period` takes a plain `AsyncSession`, nothing else). Rows are seeded with a
sync `Session` (cheap, no event loop), then read back through the real async path the app uses.

Covers the acceptance rows named in the DB-71 issue: no meetings, rows inside/outside/at the
exact period boundary, another user's rows never counted, non-joined rows not counted, minutes
with a null `end_time`, and the query-failure-reports-unknown path.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from admin_api.app.billing.meetings_usage import MeetingsUsagePort, meetings_usage_for_period
from admin_api.app.billing.ports import UsageSnapshot
from admin_api.schema.models import Base, Meeting
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker

pytestmark = requires_docker

UTC = timezone.utc
PERIOD_START = datetime(2026, 9, 1, tzinfo=UTC)
PERIOD_END = datetime(2026, 10, 1, tzinfo=UTC)


@pytest.fixture()
def engine(pg_url):
    eng = create_engine(pg_url)
    Base.metadata.drop_all(eng)
    ensure_schema_sync(eng, Base)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture()
def async_session_factory(engine, pg_async_url):
    eng = create_async_engine(pg_async_url, connect_args={"statement_cache_size": 0})
    factory = async_sessionmaker(bind=eng, class_=AsyncSession, expire_on_commit=False)
    yield factory
    asyncio.run(eng.dispose())


def _seed(engine, **fields):
    """Insert one `meetings` row with sane defaults; `created_at` is set explicitly (never the
    server default) so the window/boundary tests control it exactly."""
    defaults = dict(
        user_id=1, platform="google_meet", status="active",
        created_at=datetime(2026, 9, 15, tzinfo=UTC).replace(tzinfo=None),
    )
    defaults.update(fields)
    if defaults["created_at"].tzinfo is not None:
        defaults["created_at"] = defaults["created_at"].astimezone(UTC).replace(tzinfo=None)
    for key in ("start_time", "end_time"):
        if defaults.get(key) is not None and defaults[key].tzinfo is not None:
            defaults[key] = defaults[key].astimezone(UTC).replace(tzinfo=None)
    with Session(engine) as s:
        m = Meeting(**defaults)
        s.add(m)
        s.commit()
        return m.id


async def _usage(factory, user_id, period_start=PERIOD_START, period_end=PERIOD_END):
    async with factory() as db:
        return await meetings_usage_for_period(
            db, user_id, period_start=period_start, period_end=period_end,
        )


def test_no_meetings_reports_zero_not_unknown(async_session_factory):
    result = asyncio.run(_usage(async_session_factory, user_id=999))
    assert result == UsageSnapshot(meetings_used=0, minutes_used=0)


def test_rows_inside_and_outside_window_including_exact_boundaries(engine, async_session_factory):
    # Exactly at period_start — INCLUDED (>=).
    _seed(engine, user_id=1, status="completed", created_at=PERIOD_START,
          start_time=PERIOD_START, end_time=PERIOD_START + timedelta(minutes=10))
    # One microsecond before period_start — EXCLUDED.
    _seed(engine, user_id=1, status="completed", created_at=PERIOD_START - timedelta(microseconds=1),
          start_time=PERIOD_START, end_time=PERIOD_START + timedelta(minutes=10))
    # Exactly at period_end — EXCLUDED (period_end is exclusive).
    _seed(engine, user_id=1, status="completed", created_at=PERIOD_END,
          start_time=PERIOD_END, end_time=PERIOD_END + timedelta(minutes=10))
    # One microsecond before period_end — INCLUDED.
    _seed(engine, user_id=1, status="completed", created_at=PERIOD_END - timedelta(microseconds=1),
          start_time=PERIOD_START, end_time=PERIOD_START + timedelta(minutes=5))

    result = asyncio.run(_usage(async_session_factory, user_id=1))
    assert result.meetings_used == 2  # the two INCLUDED rows above


def test_another_users_rows_never_counted(engine, async_session_factory):
    _seed(engine, user_id=1, status="completed",
          created_at=datetime(2026, 9, 10, tzinfo=UTC))
    _seed(engine, user_id=2, status="completed",
          created_at=datetime(2026, 9, 10, tzinfo=UTC))
    _seed(engine, user_id=2, status="completed",
          created_at=datetime(2026, 9, 11, tzinfo=UTC))

    async def run():
        return (
            await _usage(async_session_factory, user_id=1),
            await _usage(async_session_factory, user_id=2),
        )

    result, result_other = asyncio.run(run())
    assert result.meetings_used == 1
    assert result_other.meetings_used == 2


def test_non_joined_rows_not_counted_joined_rows_are(engine, async_session_factory):
    at = datetime(2026, 9, 12, tzinfo=UTC)
    # Never reached the room — must NOT consume the free-plan meeting.
    _seed(engine, user_id=1, status="requested", created_at=at)
    _seed(engine, user_id=1, status="joining", created_at=at)
    _seed(engine, user_id=1, status="awaiting_admission", created_at=at)
    _seed(engine, user_id=1, status="needs_help", created_at=at)
    # A failed row that never got in (failure_stage != "active", or absent).
    _seed(engine, user_id=1, status="failed", created_at=at, data={"failure_stage": "joining"})
    _seed(engine, user_id=1, status="failed", created_at=at, data={})

    # Reached the room — MUST consume.
    _seed(engine, user_id=1, status="active", created_at=at)
    _seed(engine, user_id=1, status="stopping", created_at=at)
    _seed(engine, user_id=1, status="completed", created_at=at)
    # Admitted, then broke — also consumes (occurrence.py's SERVED rule).
    _seed(engine, user_id=1, status="failed", created_at=at, data={"failure_stage": "active"})

    result = asyncio.run(_usage(async_session_factory, user_id=1))
    assert result.meetings_used == 4


def test_minutes_with_null_end_time_counts_up_to_now_not_zero(engine, async_session_factory):
    started = datetime.now(UTC) - timedelta(minutes=30)
    _seed(engine, user_id=1, status="active", created_at=started,
          start_time=started, end_time=None)

    result = asyncio.run(_usage(
        async_session_factory, user_id=1,
        period_start=started - timedelta(days=1), period_end=started + timedelta(days=1),
    ))
    assert result.meetings_used == 1
    # ~30 minutes elapsed since start_time; never 0, never negative, and not wildly off.
    assert 28 <= result.minutes_used <= 32


def test_minutes_with_null_start_time_contributes_zero_not_an_error(engine, async_session_factory):
    at = datetime(2026, 9, 12, tzinfo=UTC)
    _seed(engine, user_id=1, status="active", created_at=at, start_time=None, end_time=None)

    result = asyncio.run(_usage(async_session_factory, user_id=1,
                                period_start=at - timedelta(days=1), period_end=at + timedelta(days=1)))
    assert result.meetings_used == 1
    assert result.minutes_used == 0


def test_query_failure_reports_unknown_never_zero(async_session_factory):
    """A DB session that can't run the query must yield `UsageSnapshot(None, None)` — never
    `(0, 0)`, which a billing page would render as "0 of 1 used" and let a quota-exceeded user
    straight through."""
    class _BrokenSession:
        async def execute(self, *args, **kwargs):
            raise RuntimeError("connection reset by peer (simulated)")

    result = asyncio.run(meetings_usage_for_period(
        _BrokenSession(), user_id=1, period_start=PERIOD_START, period_end=PERIOD_END,
    ))
    assert result == UsageSnapshot(meetings_used=None, minutes_used=None)


def test_meetings_usage_port_wraps_the_function(engine, async_session_factory):
    """`MeetingsUsagePort` is the `UsagePort`-shaped adapter `GET /user/entitlements` hands to
    `resolve_entitlements` — same answer as calling the function directly."""
    at = datetime(2026, 9, 12, tzinfo=UTC)
    _seed(engine, user_id=1, status="completed", created_at=at,
          start_time=at, end_time=at + timedelta(minutes=20))

    async def run():
        async with async_session_factory() as db:
            port = MeetingsUsagePort(db)
            return await port.usage_for_period(1, period_start=PERIOD_START, period_end=PERIOD_END)

    result = asyncio.run(run())
    assert result == UsageSnapshot(meetings_used=1, minutes_used=20)
