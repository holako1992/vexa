"""DB-32: the Microsoft Graph Calendar adapter beside the ICS and Google ones.

``parse_microsoft_events`` turns Microsoft Graph ``calendarView`` items into the SAME
``{"events": [...], "cancelled_uids": [...]}`` shape ``parse_ics``/``parse_google_events``
produce, so ``sync_user`` drives all three providers through one code path. The parity test at
the bottom proves that promise directly: an equivalent ICS event and Microsoft event, synced
through the identical ``sync_user`` call, produce identical planned-meeting rows.

``fetch_microsoft_access_token`` / ``fetch_microsoft_events`` (adapters.py) are tested against a
FAKE httpx transport — never the real network, same discipline as ``test_calendar_sync_google.py``.

Every fixture event below is TEST DATA — a recorded-shape stand-in for a real Microsoft Graph
``calendarView`` item, never a captured production payload.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from meeting_api.calendar_sync import parse_ics, parse_microsoft_events, sync_user
from meeting_api.calendar_sync.adapters import fetch_microsoft_access_token, fetch_microsoft_events
from meeting_api.collector.fakes import InMemoryTranscriptStore

USER = 7
NOW = datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc)


def _mevent(uid="evt-1", subject="Weekly sync", start="2026-07-08T15:00:00.0000000",
           location=None, join_url=None, body_content=None, is_cancelled=False,
           series_master_id=None, attendees=None) -> dict:
    ev: dict = {"id": uid, "subject": subject, "start": {"dateTime": start, "timeZone": "UTC"},
               "isCancelled": is_cancelled}
    if location:
        ev["location"] = {"displayName": location}
    if join_url:
        ev["onlineMeeting"] = {"joinUrl": join_url}
    if body_content:
        ev["body"] = {"contentType": "text", "content": body_content}
    if series_master_id:
        ev["seriesMasterId"] = series_master_id
    if attendees:
        ev["attendees"] = attendees
    return ev


# ---- parse_microsoft_events ------------------------------------------------------------

def test_parse_single_event_with_teams_join_url():
    parsed = parse_microsoft_events(
        [_mevent(join_url="https://teams.microsoft.com/l/meetup-join/"
                          "19%3ameeting_YWJjMTIz%40thread.v2/0")],
        now=NOW,
    )
    assert parsed["cancelled_uids"] == []
    (ev,) = parsed["events"]
    assert ev["uid"] == "evt-1"
    assert ev["title"] == "Weekly sync"
    assert ev["scheduled_at"] == "2026-07-08T15:00:00+00:00"
    assert ev["platform"] == "teams"


def test_parse_location_only_link():
    parsed = parse_microsoft_events(
        [_mevent(location="Conf room / https://meet.google.com/abc-defg-hij")],
        now=NOW,
    )
    (ev,) = parsed["events"]
    assert ev["platform"] == "google_meet"
    assert ev["meeting_url"] == "https://meet.google.com/abc-defg-hij"


def test_parse_body_only_link():
    parsed = parse_microsoft_events(
        [_mevent(body_content="Join Zoom: https://us02web.zoom.us/j/1234567890")],
        now=NOW,
    )
    (ev,) = parsed["events"]
    assert ev["platform"] == "zoom"


def test_parse_link_less_event_still_imports():
    parsed = parse_microsoft_events([_mevent(subject="No link here")], now=NOW)
    (ev,) = parsed["events"]
    assert ev["platform"] is None
    assert ev["native_meeting_id"] is None
    assert ev["meeting_url"] is None


def test_parse_cancelled_event_reports_uid_as_cancelled():
    parsed = parse_microsoft_events([_mevent(is_cancelled=True)], now=NOW)
    assert parsed["events"] == []
    assert parsed["cancelled_uids"] == ["evt-1"]


def test_parse_recurring_series_keeps_only_next_occurrence():
    """calendarView already expands a weekly meeting into several instances inside the window —
    grouping by seriesMasterId and keeping the earliest is what turns that back into ONE row,
    same as the Google adapter's recurringEventId fold."""
    events = [
        _mevent(uid="evt-w2", start="2026-07-15T15:00:00.0000000", series_master_id="series-1"),
        _mevent(uid="evt-w1", start="2026-07-08T15:00:00.0000000", series_master_id="series-1"),
        _mevent(uid="evt-w3", start="2026-07-22T15:00:00.0000000", series_master_id="series-1"),
    ]
    parsed = parse_microsoft_events(events, now=NOW)
    assert len(parsed["events"]) == 1
    assert parsed["events"][0]["uid"] == "series-1"
    assert parsed["events"][0]["scheduled_at"] == "2026-07-08T15:00:00+00:00"


def test_parse_attendees_filters_resources_and_maps_status():
    parsed = parse_microsoft_events([_mevent(attendees=[
        {"emailAddress": {"address": "person@example.com", "name": "Person"},
         "status": {"response": "accepted"}, "type": "required"},
        {"emailAddress": {"address": "room-9@resource.contoso.com", "name": "Room 9"},
         "status": {"response": "accepted"}, "type": "resource"},
        {"emailAddress": {"address": "waiting@example.com"},
         "status": {"response": "none"}, "type": "required"},
    ])], now=NOW)
    (ev,) = parsed["events"]
    emails = {a["email"] for a in ev["attendees"]}
    assert emails == {"person@example.com", "waiting@example.com"}
    person = next(a for a in ev["attendees"] if a["email"] == "person@example.com")
    assert person["name"] == "Person"
    assert person["partstat"] == "accepted"
    waiting = next(a for a in ev["attendees"] if a["email"] == "waiting@example.com")
    assert waiting["partstat"] == "needs-action"


def test_parse_event_outside_window_is_dropped():
    far_future = _mevent(start="2027-01-01T00:00:00.0000000")
    parsed = parse_microsoft_events([far_future], now=NOW, horizon_days=14)
    assert parsed["events"] == []


def test_parse_fractional_seconds_of_any_length_are_tolerated():
    """Graph's dateTime carries 7 fractional digits (`.0000000`); a shorter/absent tail must
    parse identically — the adapter must not depend on Graph's exact digit count."""
    parsed = parse_microsoft_events([_mevent(start="2026-07-08T15:00:00")], now=NOW)
    (ev,) = parsed["events"]
    assert ev["scheduled_at"] == "2026-07-08T15:00:00+00:00"


# ---- fetch_microsoft_access_token (mocked httpx, never the network) ------------------

_RealAsyncClient = httpx.AsyncClient  # captured BEFORE any monkeypatch — see test_calendar_sync_google.py


def _fake_async_client_cls(handler):
    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            self._client = _RealAsyncClient(transport=httpx.MockTransport(handler))

        async def __aenter__(self):
            return self._client

        async def __aexit__(self, *a):
            await self._client.aclose()

    return _FakeAsyncClient


async def test_fetch_microsoft_access_token_success(monkeypatch):
    async def handler(request):
        assert request.url.path == "/internal/calendars/cal-1/microsoft-token"
        return httpx.Response(200, json={"access_token": "eyJ.abc", "expires_in": 3599})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client_cls(handler))
    token, err = await fetch_microsoft_access_token(
        "http://admin-api", "secret", user_id=7, calendar_id="cal-1",
    )
    assert err is None
    assert token == "eyJ.abc"


async def test_fetch_microsoft_access_token_reconnect_needed(monkeypatch):
    async def handler(request):
        return httpx.Response(409, json={"detail": "reconnect_needed: invalid_grant"})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client_cls(handler))
    token, err = await fetch_microsoft_access_token(
        "http://admin-api", "secret", user_id=7, calendar_id="cal-1",
    )
    assert token is None
    assert "reconnect_needed" in err


async def test_fetch_microsoft_events_paginates_via_odata_next_link():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            assert request.url.path == "/v1.0/me/calendarView"
            return httpx.Response(200, json={
                "value": [{"id": "e1"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=250",
            })
        return httpx.Response(200, json={"value": [{"id": "e2"}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    events, err = await fetch_microsoft_events(
        "token", ["primary"], time_min="2026-07-01T00:00:00Z", time_max="2026-07-15T00:00:00Z",
        client=client,
    )
    await client.aclose()
    assert err is None
    assert [e["id"] for e in events] == ["e1", "e2"]
    assert calls["n"] == 2


async def test_fetch_microsoft_events_by_specific_calendar_id():
    def handler(request):
        assert request.url.path == "/v1.0/me/calendars/work-cal/calendarView"
        return httpx.Response(200, json={"value": [{"id": "e1"}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    events, err = await fetch_microsoft_events(
        "token", ["work-cal"], time_min="2026-07-01T00:00:00Z", time_max="2026-07-15T00:00:00Z",
        client=client,
    )
    await client.aclose()
    assert err is None
    assert [e["id"] for e in events] == ["e1"]


async def test_fetch_microsoft_events_unauthorized():
    def handler(request):
        return httpx.Response(401, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    events, err = await fetch_microsoft_events(
        "bad-token", ["primary"], time_min="2026-07-01T00:00:00Z", time_max="2026-07-15T00:00:00Z",
        client=client,
    )
    await client.aclose()
    assert events is None
    assert "unauthorized" in err.lower()


# ---- parity: an equivalent ICS event and Microsoft event yield IDENTICAL planned rows ----

async def test_ics_and_microsoft_equivalent_events_produce_identical_planned_rows():
    store_ics = InMemoryTranscriptStore()
    store_microsoft = InMemoryTranscriptStore()

    ics_text = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
        "BEGIN:VEVENT\r\nUID:parity-1\r\nDTSTAMP:20260701T000000Z\r\n"
        "DTSTART:20260708T150000Z\r\nSUMMARY:Parity meeting\r\n"
        "LOCATION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_cGFyaXR5%40thread.v2/0\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    ics_parsed = parse_ics(ics_text, now=NOW)
    microsoft_parsed = parse_microsoft_events(
        [_mevent(uid="parity-1", subject="Parity meeting", start="2026-07-08T15:00:00.0000000",
                join_url="https://teams.microsoft.com/l/meetup-join/"
                         "19%3ameeting_cGFyaXR5%40thread.v2/0")],
        now=NOW,
    )

    result_ics = await sync_user(store_ics, USER, ics_parsed, calendar_id="cal-ics",
                                 calendar_name="Work (ICS)")
    result_microsoft = await sync_user(store_microsoft, USER, microsoft_parsed,
                                       calendar_id="cal-microsoft", calendar_name="Work (Microsoft)")

    assert result_ics["counts"]["created"] == result_microsoft["counts"]["created"] == 1
    ics_id = result_ics["created"][0]["id"]
    microsoft_id = result_microsoft["created"][0]["id"]
    row_ics = next(r for r in await store_ics.list_meetings(USER) if r["id"] == ics_id)
    row_microsoft = next(r for r in await store_microsoft.list_meetings(USER) if r["id"] == microsoft_id)

    def _normalize(row):
        return {
            "title": row["data"].get("title"), "platform": row["platform"],
            "native_meeting_id": row["native_meeting_id"], "status": row["status"],
            "scheduled_at": row["data"]["scheduled_at"],
        }

    assert _normalize(row_ics) == _normalize(row_microsoft) == {
        "title": "Parity meeting", "platform": "teams",
        "native_meeting_id": "19:meeting_cGFyaXR5@thread.v2", "status": "scheduled",
        "scheduled_at": "2026-07-08T15:00:00+00:00",
    }
