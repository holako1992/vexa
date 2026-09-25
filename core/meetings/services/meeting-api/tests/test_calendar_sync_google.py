"""DB-30: the Google Calendar adapter beside the ICS one.

``parse_google_events`` turns Google Calendar API ``events.list(singleEvents=true)`` items into
the SAME ``{"events": [...], "cancelled_uids": [...]}`` shape ``parse_ics`` produces, so
``sync_user`` drives both providers through one code path. The parity test at the bottom proves
that promise directly: an equivalent ICS event and Google event, synced through the identical
``sync_user`` call, produce identical planned-meeting rows.

``fetch_google_access_token`` / ``fetch_google_events`` (adapters.py) are tested against a FAKE
httpx transport — never the real network, same discipline as ``test_calendar_sync_edges.py``.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from meeting_api.calendar_sync import parse_google_events, parse_ics, sync_user
from meeting_api.calendar_sync.adapters import fetch_google_access_token, fetch_google_events
from meeting_api.collector.fakes import InMemoryTranscriptStore

USER = 7
NOW = datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc)


def _gevent(uid="evt-1", summary="Weekly sync", start="2026-07-08T15:00:00Z",
           location=None, hangout_link=None, description=None, status=None,
           recurring_event_id=None, all_day=False, attendees=None,
           conference_entry_points=None) -> dict:
    ev: dict = {"id": uid, "summary": summary}
    if all_day:
        ev["start"] = {"date": start[:10]}
    else:
        ev["start"] = {"dateTime": start}
    if location:
        ev["location"] = location
    if hangout_link:
        ev["hangoutLink"] = hangout_link
    if description:
        ev["description"] = description
    if status:
        ev["status"] = status
    if recurring_event_id:
        ev["recurringEventId"] = recurring_event_id
    if attendees:
        ev["attendees"] = attendees
    if conference_entry_points:
        ev["conferenceData"] = {"entryPoints": conference_entry_points}
    return ev


# ---- parse_google_events --------------------------------------------------------------

def test_parse_single_event_with_hangout_link():
    parsed = parse_google_events(
        [_gevent(hangout_link="https://meet.google.com/abc-defg-hij")], now=NOW,
    )
    assert parsed["cancelled_uids"] == []
    (ev,) = parsed["events"]
    assert ev["uid"] == "evt-1"
    assert ev["title"] == "Weekly sync"
    assert ev["scheduled_at"] == "2026-07-08T15:00:00+00:00"
    assert ev["platform"] == "google_meet"
    assert ev["native_meeting_id"] == "abc-defg-hij"
    assert ev["meeting_url"] == "https://meet.google.com/abc-defg-hij"


def test_parse_conference_data_video_entry_point():
    parsed = parse_google_events([_gevent(
        conference_entry_points=[
            {"entryPointType": "phone", "uri": "tel:+1-555-0100"},
            {"entryPointType": "video", "uri": "https://us02web.zoom.us/j/1234567890"},
        ],
    )], now=NOW)
    (ev,) = parsed["events"]
    assert ev["platform"] == "zoom"
    assert ev["meeting_url"] == "https://us02web.zoom.us/j/1234567890"


def test_parse_location_only_link():
    parsed = parse_google_events(
        [_gevent(location="Conf room / https://teams.microsoft.com/l/meetup-join/"
                          "19%3ameeting_YWJjMTIz%40thread.v2/0")],
        now=NOW,
    )
    (ev,) = parsed["events"]
    assert ev["platform"] == "teams"


def test_parse_all_day_event():
    parsed = parse_google_events([_gevent(all_day=True, start="2026-07-10")], now=NOW)
    (ev,) = parsed["events"]
    assert ev["scheduled_at"] == "2026-07-10T00:00:00+00:00"


def test_parse_link_less_event_still_imports():
    parsed = parse_google_events([_gevent(summary="No link here")], now=NOW)
    (ev,) = parsed["events"]
    assert ev["platform"] is None
    assert ev["native_meeting_id"] is None
    assert ev["meeting_url"] is None


def test_parse_cancelled_event_reports_uid_as_cancelled():
    parsed = parse_google_events([_gevent(status="cancelled")], now=NOW)
    assert parsed["events"] == []
    assert parsed["cancelled_uids"] == ["evt-1"]


def test_parse_recurring_series_keeps_only_next_occurrence():
    """singleEvents=true already expands a weekly meeting into several instances inside the
    window — grouping by recurringEventId and keeping the earliest is what turns that back into
    ONE row, same as the ICS RRULE expansion's 'next occurrence only' rule."""
    events = [
        _gevent(uid="evt-w2", start="2026-07-15T15:00:00Z", recurring_event_id="series-1"),
        _gevent(uid="evt-w1", start="2026-07-08T15:00:00Z", recurring_event_id="series-1"),
        _gevent(uid="evt-w3", start="2026-07-22T15:00:00Z", recurring_event_id="series-1"),
    ]
    parsed = parse_google_events(events, now=NOW)
    assert len(parsed["events"]) == 1
    assert parsed["events"][0]["uid"] == "series-1"
    assert parsed["events"][0]["scheduled_at"] == "2026-07-08T15:00:00+00:00"


def test_parse_attendees_filters_resources_and_maps_status():
    parsed = parse_google_events([_gevent(attendees=[
        {"email": "person@example.com", "displayName": "Person", "responseStatus": "accepted"},
        {"email": "room-9@resource.calendar.google.com", "resource": True,
         "responseStatus": "accepted"},
        {"email": "waiting@example.com", "responseStatus": "needsAction"},
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
    far_future = _gevent(start="2027-01-01T00:00:00Z")
    parsed = parse_google_events([far_future], now=NOW, horizon_days=14)
    assert parsed["events"] == []


# ---- fetch_google_access_token (mocked httpx, never the network) ----------------------

_RealAsyncClient = httpx.AsyncClient  # captured BEFORE any monkeypatch — the fake wraps THIS,
                                       # never the (possibly already-patched) module attribute,
                                       # or __init__ recurses into itself forever.


def _fake_async_client_cls(handler):
    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            self._client = _RealAsyncClient(transport=httpx.MockTransport(handler))

        async def __aenter__(self):
            return self._client

        async def __aexit__(self, *a):
            await self._client.aclose()

    return _FakeAsyncClient


async def test_fetch_google_access_token_success(monkeypatch):
    async def handler(request):
        assert request.url.path == "/internal/calendars/cal-1/google-token"
        return httpx.Response(200, json={"access_token": "ya29.abc", "expires_in": 3599})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client_cls(handler))
    token, err = await fetch_google_access_token(
        "http://admin-api", "secret", user_id=7, calendar_id="cal-1",
    )
    assert err is None
    assert token == "ya29.abc"


async def test_fetch_google_access_token_reconnect_needed(monkeypatch):
    async def handler(request):
        return httpx.Response(409, json={"detail": "reconnect_needed: invalid_grant"})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client_cls(handler))
    token, err = await fetch_google_access_token(
        "http://admin-api", "secret", user_id=7, calendar_id="cal-1",
    )
    assert token is None
    assert "reconnect_needed" in err


async def test_fetch_google_events_paginates_and_bounds_pages():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if "pageToken" not in request.url.params:
            return httpx.Response(200, json={"items": [{"id": "e1"}], "nextPageToken": "p2"})
        return httpx.Response(200, json={"items": [{"id": "e2"}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    events, err = await fetch_google_events(
        "token", ["primary"], time_min="2026-07-01T00:00:00Z", time_max="2026-07-15T00:00:00Z",
        client=client,
    )
    await client.aclose()
    assert err is None
    assert [e["id"] for e in events] == ["e1", "e2"]
    assert calls["n"] == 2


async def test_fetch_google_events_unauthorized():
    def handler(request):
        return httpx.Response(401, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    events, err = await fetch_google_events(
        "bad-token", ["primary"], time_min="2026-07-01T00:00:00Z", time_max="2026-07-15T00:00:00Z",
        client=client,
    )
    await client.aclose()
    assert events is None
    assert "unauthorized" in err.lower()


# ---- parity: an equivalent ICS event and Google event yield IDENTICAL planned rows ----

async def test_ics_and_google_equivalent_events_produce_identical_planned_rows():
    store_ics = InMemoryTranscriptStore()
    store_google = InMemoryTranscriptStore()

    ics_text = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
        "BEGIN:VEVENT\r\nUID:parity-1\r\nDTSTAMP:20260701T000000Z\r\n"
        "DTSTART:20260708T150000Z\r\nSUMMARY:Parity meeting\r\n"
        "LOCATION:https://meet.google.com/par-itya-bcd\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    ics_parsed = parse_ics(ics_text, now=NOW)
    google_parsed = parse_google_events(
        [_gevent(uid="parity-1", summary="Parity meeting", start="2026-07-08T15:00:00Z",
                hangout_link="https://meet.google.com/par-itya-bcd")],
        now=NOW,
    )

    result_ics = await sync_user(store_ics, USER, ics_parsed, calendar_id="cal-ics",
                                 calendar_name="Work (ICS)")
    result_google = await sync_user(store_google, USER, google_parsed, calendar_id="cal-google",
                                    calendar_name="Work (Google)")

    assert result_ics["counts"]["created"] == result_google["counts"]["created"] == 1
    ics_id = result_ics["created"][0]["id"]
    google_id = result_google["created"][0]["id"]
    row_ics = next(r for r in await store_ics.list_meetings(USER) if r["id"] == ics_id)
    row_google = next(r for r in await store_google.list_meetings(USER) if r["id"] == google_id)

    def _normalize(row):
        return {
            "title": row["data"].get("title"), "platform": row["platform"],
            "native_meeting_id": row["native_meeting_id"], "status": row["status"],
            "scheduled_at": row["data"]["scheduled_at"],
        }

    assert _normalize(row_ics) == _normalize(row_google) == {
        "title": "Parity meeting", "platform": "google_meet",
        "native_meeting_id": "par-itya-bcd", "status": "scheduled",
        "scheduled_at": "2026-07-08T15:00:00+00:00",
    }
