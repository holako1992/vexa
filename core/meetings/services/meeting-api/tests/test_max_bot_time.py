"""Per-plan per-meeting minute cap — the effective ``automatic_leave.max_bot_time`` a spawn hands
the bot is ``min(deployment BOT_MAX_ACTIVE_MS, plan minute cap, caller-supplied max_bot_time)``.

meeting-api only ever computes two of the three legs (the deployment env cap is read by the bot
itself, in ``services/bot/src/index.ts``'s ``deriveMaxActiveMs`` — see
``services/bot/src/max-active-cap.test.ts`` for that leg). This suite covers:

  * the pure resolver (``bot_spawn.max_bot_time.resolve_max_bot_time_ms``) in isolation — both
    present (minimum wins), either missing, both missing (``None``), and the "plan resolved to
    Free" shape (60 minutes — ``billing/catalog.py``'s own default for an unrecognized plan id,
    core/identity);
  * the router (``_resolve_automatic_leave``) actually threading a caller's ``max_bot_time`` into
    ``maxBotTime`` — it used to be accepted (present in the allowed-keys set, so never a 422) and
    silently dropped;
  * the full spawn (``request_bot``) combining the caller's value with the plan's cap off the SAME
    best-effort ``bot_context`` fetch the monthly quota already uses (no second admin-api call),
    and leaving the waiting-room default intact either way.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import build_router, request_bot
from meeting_api.bot_spawn import service as spawn_service
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.max_bot_time import resolve_max_bot_time_ms
from meeting_api.bot_spawn.router import _resolve_automatic_leave

SECRET = "test-admin-token"
USER = 7
HEADERS = {"x-user-id": str(USER)}
URL = "https://meet.google.com/abc-defg-hij"

# billing/catalog.py's own numbers (core/identity) — restated here as plain data, not imported
# across the service boundary (meeting-api talks to admin-api over HTTP only, never Python).
FREE_MAX_MINUTES = 60
PRO_MAX_MINUTES = 240


# ── unit: the pure resolver ───────────────────────────────────────────────────────────────────────

def test_resolve_takes_the_minimum_of_both():
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=90 * 60_000, plan_max_minutes_per_meeting=FREE_MAX_MINUTES,
    ) == FREE_MAX_MINUTES * 60_000  # the plan's 60min beats the caller's 90min


def test_resolve_caller_shorter_than_plan_wins():
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=10 * 60_000, plan_max_minutes_per_meeting=PRO_MAX_MINUTES,
    ) == 10 * 60_000  # the caller may always ask for something SHORTER than their plan


def test_resolve_missing_caller_value_falls_back_to_plan():
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=None, plan_max_minutes_per_meeting=FREE_MAX_MINUTES,
    ) == FREE_MAX_MINUTES * 60_000


def test_resolve_missing_plan_falls_back_to_caller():
    """An unlimited plan (Pro/Team's `max_minutes_per_meeting` — never actually None in the
    current catalog, but the resolver must not assume every plan states one) leaves the caller's
    own value untouched."""
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=45 * 60_000, plan_max_minutes_per_meeting=None,
    ) == 45 * 60_000


def test_resolve_both_missing_is_none():
    """Neither the plan nor the caller named a cap → `None` — the bot's own deployment-wide
    `BOT_MAX_ACTIVE_MS` applies alone; this function must never invent a cap from nothing."""
    assert resolve_max_bot_time_ms(caller_max_bot_time_ms=None, plan_max_minutes_per_meeting=None) is None


def test_resolve_unknown_plan_resolves_to_free_sixty_minutes():
    """`billing.catalog.get_plan` resolves an unrecognized plan id (or no subscription at all) to
    Free BEFORE meeting-api ever sees a number — this is what that 60-minute cap looks like once it
    reaches the resolver, with no caller opinion to narrow it further."""
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=None, plan_max_minutes_per_meeting=FREE_MAX_MINUTES,
    ) == 60 * 60_000


def test_resolve_zero_caller_value_is_not_special_cased_here():
    """`0` is never sent by the router (`_resolve_automatic_leave`'s `timeout()` helper 422s a
    non-positive `max_bot_time` before this function ever runs) — this resolver takes whatever
    non-None number it is given at face value; the positivity rule lives at the request boundary."""
    assert resolve_max_bot_time_ms(
        caller_max_bot_time_ms=0, plan_max_minutes_per_meeting=FREE_MAX_MINUTES,
    ) == 0


# ── unit: the router actually threads max_bot_time through ───────────────────────────────────────

def test_resolve_automatic_leave_threads_max_bot_time():
    resolved = _resolve_automatic_leave({"max_bot_time": 1_800_000})
    assert resolved["maxBotTime"] == 1_800_000
    assert resolved["waitingRoomTimeout"]  # the lobby default is still filled


def test_resolve_automatic_leave_omits_max_bot_time_when_absent():
    resolved = _resolve_automatic_leave({"max_wait_for_admission": 60_000})
    assert "maxBotTime" not in resolved


def test_resolve_automatic_leave_rejects_non_positive_max_bot_time():
    with pytest.raises(Exception) as exc:
        _resolve_automatic_leave({"max_bot_time": 0})
    assert "max_bot_time" in str(exc.value.detail if hasattr(exc.value, "detail") else exc.value)


# ── integration: request_bot combines the caller's value with the plan cap ───────────────────────

def _client(repo=None, runtime=None):
    app = FastAPI()
    app.include_router(build_router(repo or InMemoryMeetingRepo(), runtime or FakeRuntimeClient()))
    return TestClient(app)


async def _async_return(value):
    return value


def _stub_bot_context(monkeypatch, context: dict):
    monkeypatch.setattr(spawn_service, "_fetch_bot_context", lambda user_id: _async_return(context))


def test_plan_cap_alone_sets_max_bot_time(monkeypatch):
    """No caller `automatic_leave` at all — a Free plan's 60-minute cap still lands on the
    invocation, and the waiting-room default is still filled (the plan-cap-only dict is non-empty,
    so a plain `automatic_leave or {default}` would have skipped the fill)."""
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    runtime = FakeRuntimeClient()
    _stub_bot_context(monkeypatch, {"max_minutes_per_meeting": FREE_MAX_MINUTES})
    r = _client(runtime=runtime).post(
        "/bots", headers=HEADERS,
        json={"platform": "google_meet", "native_meeting_id": "plan-cap-only"},
    )
    assert r.status_code == 201, r.text
    inv = json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])
    assert inv["automaticLeave"]["maxBotTime"] == FREE_MAX_MINUTES * 60_000
    assert inv["automaticLeave"]["waitingRoomTimeout"] == 900_000


def test_caller_value_smaller_than_plan_cap_wins(monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    runtime = FakeRuntimeClient()
    _stub_bot_context(monkeypatch, {"max_minutes_per_meeting": PRO_MAX_MINUTES})  # 240min
    r = _client(runtime=runtime).post(
        "/bots", headers=HEADERS,
        json={
            "platform": "google_meet", "native_meeting_id": "caller-shorter",
            "automatic_leave": {"max_bot_time": 15 * 60_000},  # 15min — shorter than the plan
        },
    )
    assert r.status_code == 201, r.text
    inv = json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])
    assert inv["automaticLeave"]["maxBotTime"] == 15 * 60_000


def test_plan_cap_smaller_than_caller_value_wins(monkeypatch):
    """The caller cannot buy MORE time than their plan allows by asking for it — the plan's cap
    narrows a too-generous caller request."""
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    runtime = FakeRuntimeClient()
    _stub_bot_context(monkeypatch, {"max_minutes_per_meeting": FREE_MAX_MINUTES})  # 60min
    r = _client(runtime=runtime).post(
        "/bots", headers=HEADERS,
        json={
            "platform": "google_meet", "native_meeting_id": "plan-shorter",
            "automatic_leave": {"max_bot_time": 180 * 60_000},  # 3h — longer than the Free cap
        },
    )
    assert r.status_code == 201, r.text
    inv = json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])
    assert inv["automaticLeave"]["maxBotTime"] == FREE_MAX_MINUTES * 60_000


def test_no_billing_wired_and_no_caller_value_omits_max_bot_time(monkeypatch):
    """No ADMIN_API_URL/INTERNAL_API_SECRET → `_fetch_bot_context` (real, unstubbed) answers `{}`
    → no plan cap; the caller named none either → `maxBotTime` never appears, unchanged from
    before this cap existed."""
    monkeypatch.delenv("ADMIN_API_URL", raising=False)
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    runtime = FakeRuntimeClient()
    r = _client(runtime=runtime).post(
        "/bots", headers=HEADERS,
        json={"platform": "google_meet", "native_meeting_id": "no-billing"},
    )
    assert r.status_code == 201, r.text
    inv = json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])
    assert "maxBotTime" not in inv["automaticLeave"]
    assert inv["automaticLeave"] == {"waitingRoomTimeout": 900_000}


async def test_unit_request_bot_combines_plan_and_caller(monkeypatch):
    """The same combination, exercised at the `request_bot` unit level with no HTTP layer — the
    same seam the monthly-quota suite (test_monthly_quota.py) uses for `MeetingQuotaExceeded`."""
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    _stub_bot_context(monkeypatch, {"max_minutes_per_meeting": FREE_MAX_MINUTES})
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    meeting = await request_bot(
        repo, runtime, user_id=USER, platform="google_meet", native_meeting_id="m-1",
        meeting_url=URL, redis_url="r", token_secret=SECRET,
        meeting_api_url="http://meeting-api:8080",
        automatic_leave={"maxBotTime": 90 * 60_000},  # 90min — longer than the 60min Free cap (already camelCase: request_bot is called below the router's snake_case translation)
    )
    inv = json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])
    assert inv["automaticLeave"]["maxBotTime"] == FREE_MAX_MINUTES * 60_000
    assert meeting["status"] == "requested"
