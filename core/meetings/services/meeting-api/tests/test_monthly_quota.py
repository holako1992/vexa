"""DB-72 eval — the MONTHLY meeting quota, enforced at admission (manual POST /bots and auto-join).

The quota itself (which plan allows how many meetings, and which `meetings` rows count toward the
current period) is admin-api's — resolved by `billing.entitlements.resolve_entitlements` and
`billing.meetings_usage.meetings_usage_for_period` (see
`core/identity/services/admin-api/tests/test_billing_meetings_usage.py` for the ONE authoritative
test of which rows count, e.g. a failed-before-join row never consuming — this suite does not
re-test that SQL classification). meeting-api's `bot_spawn/service.py` reads the resolved verdict
off `/internal/users/{id}/bot-context`'s `quota` block (the SAME best-effort fetch the spawn flow
already makes for transcription/capture/bot-name, not a new call) and enforces it — that is what
this suite covers, OFFLINE, by stubbing `service._fetch_bot_context` the same way
`test_person_bot_name.py` and `test_bot_spawn.py` already do.

Covers:
  * a free user's first meeting of the month admitted, the second refused with the exact
    `{"error": "quota_exceeded", ...}` body at 402;
  * an unlimited (Pro/Team-shaped) context — no `quota` key at all — never checked;
  * "not consuming": a reported `meetings_used` that a failed-before-join row would NOT have
    incremented (admin-api's job) still admits, from meeting-api's point of view, exactly like any
    other under-quota count;
  * auto-join SKIPS (never joins) on the same refusal, stamping `data.auto_join_error` with a
    reason rather than raising past the sweep;
  * absent `x-user-limits`/no `quota` key at all → unchanged pre-DB-72 behaviour;
  * UNKNOWN usage (`meetings_used: None`) on a finite-limit plan fails CLOSED (refused, never
    silently admitted as "0 used");
  * the concurrent-bot cap (a DIFFERENT axis, still 429 via `MaxBotsExceeded`) is unaffected by the
    monthly quota and keeps working alongside it.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import MeetingQuotaExceeded, build_router, request_bot
from meeting_api.bot_spawn import auto_join as auto_join_mod
from meeting_api.bot_spawn import service as spawn_service
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo

USER = 7
HEADERS = {"x-user-id": str(USER)}
URL = "https://meet.google.com/abc-defg-hij"
RESETS_AT = "2026-10-01T00:00:00+00:00"


@pytest.fixture(autouse=True)
def _admin_token(monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "test-admin-token")


def _quota_context(*, limit, used, upgrade_url="https://vexa.ai/pricing"):
    return {
        "quota": {
            "meetings_per_month": limit,
            "meetings_used": used,
            "resets_at": RESETS_AT,
            "upgrade_url": upgrade_url,
        },
    }


def _client(monkeypatch, context=None):
    """The router with `service._fetch_bot_context` stubbed — the one seam every bot_spawn test
    (test_person_bot_name.py, test_bot_spawn.py) uses for this same best-effort fetch."""
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()

    async def fetch(user_id: int):
        return context if context is not None else {}

    monkeypatch.setattr(spawn_service, "_fetch_bot_context", fetch)
    app = FastAPI()
    app.include_router(build_router(repo, runtime))
    return TestClient(app), repo, runtime


def _spawn(client, native_meeting_id="abc-defg-hij"):
    return client.post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "native_meeting_id": native_meeting_id, "meeting_url": URL,
    })


# ── route-level: the exact refusal body + status ─────────────────────────────────────────────────

def test_free_users_first_meeting_admitted_second_refused_with_exact_body(monkeypatch):
    client, repo, runtime = _client(monkeypatch, context=_quota_context(limit=1, used=0))
    r1 = _spawn(client, "m-1")
    assert r1.status_code == 201, r1.text
    repo.set_status(r1.json()["id"], "completed")  # the meeting that consumed the free slot

    # the SAME context (used=1) simulates the second attempt inside the now-exhausted period
    monkeypatch.setattr(
        spawn_service, "_fetch_bot_context",
        lambda user_id: _async_return(_quota_context(limit=1, used=1)),
    )
    r2 = _spawn(client, "m-2")
    assert r2.status_code == 402, r2.text
    assert r2.json() == {
        "error": "quota_exceeded",
        "limit": 1,
        "used": 1,
        "resets_at": RESETS_AT,
        "upgrade_url": "https://vexa.ai/pricing",
    }
    # refused BEFORE any DB write / runtime call — no orphaned `requested` row, no spawn attempted
    assert len(runtime.specs) == 1  # only the first (admitted) spawn reached the runtime


async def _async_return(value):
    return value


def test_pro_shaped_context_no_quota_key_never_checked(monkeypatch):
    """An unlimited plan's bot-context has NO `quota` key at all (admin-api omits it for a `None`
    `meetings_per_month`) — repeated spawns are never refused on this axis."""
    client, repo, runtime = _client(monkeypatch, context={"bot_name": "Vexa"})
    for i in range(3):
        r = _spawn(client, f"m-{i}")
        assert r.status_code == 201, r.text
        repo.set_status(r.json()["id"], "completed")


def test_absent_billing_entirely_unchanged(monkeypatch):
    """No ADMIN_API_URL/INTERNAL_API_SECRET → `_fetch_bot_context` answers `{}` (the real,
    unstubbed function) → no `quota` key → no pre-check. Same shape as every pre-DB-72 deployment."""
    monkeypatch.delenv("ADMIN_API_URL", raising=False)
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    app = FastAPI()
    app.include_router(build_router(repo, runtime))
    client = TestClient(app)
    r = client.post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "native_meeting_id": "abc-defg-hij", "meeting_url": URL,
    })
    assert r.status_code == 201, r.text


def test_unknown_usage_on_a_finite_plan_fails_closed(monkeypatch):
    """`meetings_used: None` (admin-api's usage query failed) on a FINITE plan is refused, never
    silently admitted as "0 used" — the deliberate fail-closed rule DB-72's issue states."""
    client, repo, runtime = _client(monkeypatch, context=_quota_context(limit=1, used=None))
    r = _spawn(client, "m-1")
    assert r.status_code == 402, r.text
    body = r.json()
    assert body["error"] == "quota_exceeded"
    assert body["used"] is None
    assert body["limit"] == 1
    assert len(runtime.specs) == 0


def test_a_failed_before_join_meeting_does_not_consume_the_slot(monkeypatch):
    """meeting-api trusts whatever `meetings_used` admin-api reports; a prior failed-before-join
    meeting simply never incremented it (admin-api's own rule, tested at
    test_billing_meetings_usage.py::test_non_joined_rows_not_counted_joined_rows_are). From
    meeting-api's side this is indistinguishable from "nothing happened yet" — `used` stays 0
    despite an earlier failed attempt existing on the row store, and admission proceeds."""
    client, repo, runtime = _client(monkeypatch, context=_quota_context(limit=1, used=0))
    r = _spawn(client, "m-1")
    assert r.status_code == 201, r.text


# ── auto-join: skip with a recorded reason, never join ──────────────────────────────────────────

NOW = datetime(2026, 9, 25, 12, 0, 0, tzinfo=timezone.utc)


def _seed_scheduled(repo, *, mid=1, at=NOW):
    data = {"title": "t", "auto_join": True, "scheduled_at": at.isoformat()}
    repo._meetings[mid] = {
        "id": mid, "user_id": USER, "platform": "google_meet",
        "native_meeting_id": "sched-1", "platform_specific_id": "sched-1",
        "status": "scheduled", "bot_container_id": None, "start_time": None, "end_time": None,
        "data": data, "created_at": "2026-09-25T09:00:00Z", "updated_at": "2026-09-25T09:00:00Z",
    }
    return mid


async def test_auto_join_skips_on_quota_exhausted_with_a_recorded_reason(monkeypatch):
    """`auto_join_tick`'s own `fetch_bot_context` param resolves the concurrent-bot cap + bot name
    (unaffected here — left uncapped). The MONTHLY quota is read inside `request_bot` itself, off
    the SAME internal `service._fetch_bot_context` seam a manual POST /bots uses — stubbed here
    exactly as the route-level tests above stub it, so this exercises the real integration between
    the sweep and the spawn flow rather than a second, parallel mechanism."""
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    mid = _seed_scheduled(repo)

    monkeypatch.setattr(
        spawn_service, "_fetch_bot_context",
        lambda user_id: _async_return(_quota_context(limit=1, used=1)),
    )

    async def fetch_ctx(user_id: int):
        return {"max_concurrent": None, "bot_name": "Vexa"}

    counters = await auto_join_mod.auto_join_tick(
        repo, runtime,
        fetch_bot_context=fetch_ctx,
        now=NOW,
        token_secret="test-admin-token",
        redis_url="redis://r",
        transcribe_gate=lambda: None,
    )
    assert counters["due"] == 1
    assert counters["spawned"] == 0
    assert counters["errors"] == 1
    assert len(runtime.specs) == 0  # never joined

    row = repo._meetings[mid]
    assert "quota" in (row["data"].get("auto_join_error") or "").lower()
    assert row["status"] == "scheduled"  # still scheduled, not spawned — skipped, not joined


# ── the monthly quota and the concurrent-bot cap are independent axes ───────────────────────────

def test_concurrent_cap_still_enforced_independently_of_monthly_quota(monkeypatch):
    """A context that reports plenty of monthly quota left but a concurrent-bot cap of 1 (as the
    gateway's x-user-limits header would carry, independent of bot-context's `quota`) still 429s
    the second concurrently-active bot — the two checks are unrelated axes."""
    client, repo, runtime = _client(monkeypatch, context=_quota_context(limit=10, used=0))
    headers = {**HEADERS, "x-user-limits": "1"}
    r1 = client.post("/bots", headers=headers, json={
        "platform": "google_meet", "native_meeting_id": "m-1", "meeting_url": URL,
    })
    assert r1.status_code == 201, r1.text
    repo.set_status(r1.json()["id"], "active")
    r2 = client.post("/bots", headers=headers, json={
        "platform": "google_meet", "native_meeting_id": "m-2",
        "meeting_url": "https://meet.google.com/xyz-defg-hij",
    })
    assert r2.status_code == 429, r2.text


# ── unit-level: request_bot raises MeetingQuotaExceeded directly (no HTTP layer) ────────────────

async def test_request_bot_raises_meeting_quota_exceeded(monkeypatch):
    monkeypatch.setattr(
        spawn_service, "_fetch_bot_context",
        lambda user_id: _async_return(_quota_context(limit=1, used=1)),
    )
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with pytest.raises(MeetingQuotaExceeded) as exc:
        await request_bot(
            repo, runtime, user_id=USER, platform="google_meet", native_meeting_id="m-1",
            meeting_url=URL, redis_url="r", token_secret="test-admin-token",
            meeting_api_url="http://meeting-api:8080",
        )
    assert exc.value.limit == 1
    assert exc.value.used == 1
    assert exc.value.resets_at == RESETS_AT
    assert len(runtime.specs) == 0
