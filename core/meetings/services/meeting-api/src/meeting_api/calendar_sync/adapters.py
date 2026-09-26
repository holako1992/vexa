"""Production I/O for calendar sync — the ICS fetch (SSRF-pinned) + the config discovery hop.

``fetch_ics`` dereferences a USER-SUPPLIED URL server-side, so it MUST ride the same pinned
transport the webhook sender uses (``webhooks/ssrf.build_pinned_transport``): the host is
resolved + validated at connect time and the socket dials the validated IP — a DNS-rebinding
flip can never turn the poller into an internal-network probe. Size-capped: a feed larger than
``MAX_ICS_BYTES`` is refused, not parsed.

``fetch_configs`` asks admin-api's internal edge (X-Internal-Secret) which users have a feed
connected — the secret URL crosses only this internal hop.

DB-32 adds the Microsoft Graph pair (``fetch_microsoft_access_token`` / ``fetch_microsoft_events``)
beside the Google one (``fetch_google_access_token`` / ``fetch_google_events``) — same shapes,
same fail-loud rules, a different provider's token-mint edge and events endpoint.
"""
from __future__ import annotations

from typing import Optional

MAX_ICS_BYTES = 2 * 1024 * 1024  # 2 MB — a personal calendar feed is KBs; refuse anything huge


def build_ics_client(*, timeout_s: float = 15.0):
    """A pinned httpx client for ICS fetches — the ONE place the transport is configured.

    A sweep that reuses a single client across a tick's feeds keeps connection pooling and TLS
    handshakes amortized; ``fetch_ics`` builds a per-call one when no client is passed.
    """
    import httpx

    from ..webhooks.ssrf import build_pinned_transport

    return httpx.AsyncClient(
        timeout=timeout_s, transport=build_pinned_transport(), follow_redirects=False,
    )


async def fetch_ics(url: str, *, timeout_s: float = 15.0,
                    client=None) -> tuple[Optional[str], Optional[str]]:
    """GET the ICS feed over the SSRF-pinned transport → ``(feed_text, None)`` on success or
    ``(None, human_reason)`` on any failure. The reason is USER-FACING (it becomes the feed's
    ``last_error`` and is shown in the terminal's calendar panel), so it names the actual
    problem — an HTML page instead of a feed, a bad status, oversize — never a stack trace.

    ``client`` (optional) is a caller-owned pinned client — pass one to share a connection pool
    across a sweep; the caller owns its lifetime."""
    try:
        if client is not None:
            resp = await client.get(url)
        else:
            async with build_ics_client(timeout_s=timeout_s) as owned:
                resp = await owned.get(url)
        if resp.status_code in (301, 302, 303, 307, 308):
            return None, "the URL redirects — paste the final feed URL (Google: the 'Secret address in iCal format')"
        if resp.status_code != 200:
            return None, f"the URL answered HTTP {resp.status_code}"
        if len(resp.content) > MAX_ICS_BYTES:
            return None, "the feed is too large (over 2 MB)"
        text = resp.text
        head = text.lstrip()[:200].lower()
        if head.startswith("<") or "<html" in head:
            return None, ("the URL returns a web page, not a calendar feed — in Google Calendar use "
                          "Settings → Integrate calendar → 'Secret address in iCal format' (ends in .ics)")
        if "begin:vcalendar" not in head:
            return None, "the URL doesn't return an ICS calendar (no BEGIN:VCALENDAR)"
        return text, None
    except Exception:
        return None, "couldn't reach the URL (unreachable, timed out, or a blocked/internal address)"


async def fetch_configs(admin_api_url: str, internal_secret: str,
                        *, timeout_s: float = 10.0) -> Optional[list[dict]]:
    """``[{user_id, ics_url, auto_join}]`` from admin-api's internal calendar-configs edge, or
    ``None`` when identity is unreachable (the sweep skips the tick — fail-closed, not fail-silent).
    A Google- or Microsoft-kind config (``kind: "google"``/``"microsoft"``) carries no credential
    — see ``fetch_google_access_token`` / ``fetch_microsoft_access_token``."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(
                f"{admin_api_url.rstrip('/')}/internal/calendar-configs",
                headers={"X-Internal-Secret": internal_secret},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        configs = body.get("configs") if isinstance(body, dict) else None
        return configs if isinstance(configs, list) else None
    except Exception:
        return None


GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
MAX_GOOGLE_EVENTS_PAGES = 20  # a personal calendar's 14-day window is a handful of pages; bounded


async def fetch_google_access_token(admin_api_url: str, internal_secret: str, *, user_id: int,
                                    calendar_id: str, timeout_s: float = 10.0
                                    ) -> tuple[Optional[str], Optional[str]]:
    """A short-lived Google access token for this connection, via admin-api's internal edge —
    meeting-api NEVER reads identity's tables or an encrypted refresh token directly (the core
    owns its contracts; a consumer is handed a capability, not a credential).

    Returns ``(token, None)`` on success, or ``(None, reason)`` on any failure. A 409 from
    admin-api means the stored grant is revoked/expired (``reconnect_needed`` — admin-api has
    already flipped that flag on the connection); the reason threads through to the sync stamp's
    ``last_error`` verbatim so the panel shows the SAME "reconnect" wording either way."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                f"{admin_api_url.rstrip('/')}/internal/calendars/{calendar_id}/google-token",
                headers={"X-Internal-Secret": internal_secret},
                json={"user_id": user_id},
            )
    except Exception:
        return None, "couldn't reach identity to refresh the Google access token"
    if resp.status_code == 409:
        try:
            detail = resp.json().get("detail")
        except Exception:
            detail = None
        return None, detail or "reconnect_needed: the Google grant was revoked or expired — reconnect this calendar"
    if resp.status_code != 200:
        return None, f"identity's Google token edge answered HTTP {resp.status_code}"
    try:
        token = resp.json().get("access_token")
    except Exception:
        token = None
    if not token:
        return None, "identity's Google token edge returned no access_token"
    return token, None


GRAPH_ME_CALENDARVIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView"
GRAPH_CALENDAR_CALENDARVIEW_URL = "https://graph.microsoft.com/v1.0/me/calendars/{calendar_id}/calendarView"
MAX_MICROSOFT_EVENTS_PAGES = 20  # same bound as MAX_GOOGLE_EVENTS_PAGES — a personal window is a handful


async def fetch_microsoft_access_token(admin_api_url: str, internal_secret: str, *, user_id: int,
                                       calendar_id: str, timeout_s: float = 10.0
                                       ) -> tuple[Optional[str], Optional[str]]:
    """A short-lived Microsoft Graph access token for this connection, via admin-api's internal
    edge — meeting-api NEVER reads identity's tables or an encrypted refresh token directly. Same
    shape as ``fetch_google_access_token`` (DB-32 mirrors DB-30)."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                f"{admin_api_url.rstrip('/')}/internal/calendars/{calendar_id}/microsoft-token",
                headers={"X-Internal-Secret": internal_secret},
                json={"user_id": user_id},
            )
    except Exception:
        return None, "couldn't reach identity to refresh the Microsoft access token"
    if resp.status_code == 409:
        try:
            detail = resp.json().get("detail")
        except Exception:
            detail = None
        return None, detail or "reconnect_needed: the Microsoft grant was revoked or expired — reconnect this calendar"
    if resp.status_code != 200:
        return None, f"identity's Microsoft token edge answered HTTP {resp.status_code}"
    try:
        token = resp.json().get("access_token")
    except Exception:
        token = None
    if not token:
        return None, "identity's Microsoft token edge returned no access_token"
    return token, None


async def fetch_microsoft_events(access_token: str, calendar_ids: list[str], *,
                                 time_min: str, time_max: str, timeout_s: float = 15.0,
                                 client=None) -> tuple[Optional[list[dict]], Optional[str]]:
    """Graph ``calendarView`` (already occurrence-expanded, like Google's ``singleEvents=true``)
    across every ``calendar_ids`` entry, following ``@odata.nextLink`` pagination on each, bounded
    to the same time window ``parse_microsoft_events`` re-applies. ``"primary"`` (the connection's
    default calendar id, mirroring Google's) reads ``/me/calendarView``; any other id reads
    ``/me/calendars/{id}/calendarView``. ``Prefer: outlook.timezone="UTC"`` pins every
    ``start``/``end`` to UTC regardless of the account's own timezone, so the parser never needs
    to resolve a Windows/IANA timezone name. Returns ``(events, None)`` on success (the raw item
    list, unfiltered by calendar) or ``(None, reason)`` on the first calendar's failure — a
    partial multi-calendar result is never silently returned, the same fail-loud rule
    ``fetch_google_events`` follows."""
    import httpx

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=timeout_s)
    headers = {"Authorization": f"Bearer {access_token}", "Prefer": 'outlook.timezone="UTC"'}
    try:
        out: list[dict] = []
        for calendar_id in calendar_ids:
            url = (GRAPH_ME_CALENDARVIEW_URL if calendar_id == "primary"
                  else GRAPH_CALENDAR_CALENDARVIEW_URL.format(calendar_id=calendar_id))
            params = {"startDateTime": time_min, "endDateTime": time_max, "$top": "250",
                      "$orderby": "start/dateTime"}
            for _ in range(MAX_MICROSOFT_EVENTS_PAGES):
                try:
                    resp = await client.get(url, params=params, headers=headers)
                except Exception:
                    return None, f"couldn't reach Microsoft Graph for calendar '{calendar_id}'"
                if resp.status_code == 401:
                    return None, "Microsoft Graph rejected the access token (unauthorized)"
                if resp.status_code == 404:
                    return None, f"calendar '{calendar_id}' was not found (or is no longer shared)"
                if resp.status_code != 200:
                    return None, f"Microsoft Graph answered HTTP {resp.status_code} for calendar '{calendar_id}'"
                body = resp.json()
                out.extend(body.get("value") or [])
                next_link = body.get("@odata.nextLink")
                if not next_link:
                    break
                url, params = next_link, None  # nextLink is a complete URL — no params to re-add
        return out, None
    finally:
        if owns_client:
            await client.aclose()


async def fetch_google_events(access_token: str, calendar_ids: list[str], *,
                              time_min: str, time_max: str, timeout_s: float = 15.0,
                              client=None) -> tuple[Optional[list[dict]], Optional[str]]:
    """``events.list(singleEvents=true)`` across every ``calendar_ids`` entry, following
    ``nextPageToken`` pagination on each, bounded to a sane time window (the same
    ``DEFAULT_HORIZON_DAYS``/``DEFAULT_LOOKBACK_S`` window ``parse_google_events`` re-applies —
    Google's own filtering is the outer bound, the parser's is the authoritative one). Returns
    ``(events, None)`` on success (the raw item list, unfiltered by calendar) or ``(None, reason)``
    on the first calendar's failure — a partial multi-calendar result is never silently returned,
    the same fail-loud rule ``fetch_ics`` follows."""
    import httpx

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=timeout_s)
    try:
        out: list[dict] = []
        for calendar_id in calendar_ids:
            page_token = None
            for _ in range(MAX_GOOGLE_EVENTS_PAGES):
                params = {
                    "singleEvents": "true", "timeMin": time_min, "timeMax": time_max,
                    "maxResults": "250", "orderBy": "startTime",
                }
                if page_token:
                    params["pageToken"] = page_token
                url = GOOGLE_EVENTS_URL.format(calendar_id=calendar_id)
                try:
                    resp = await client.get(
                        url, params=params,
                        headers={"Authorization": f"Bearer {access_token}"},
                    )
                except Exception:
                    return None, f"couldn't reach Google Calendar for calendar '{calendar_id}'"
                if resp.status_code == 401:
                    return None, "Google rejected the access token (unauthorized)"
                if resp.status_code == 404:
                    return None, f"calendar '{calendar_id}' was not found (or is no longer shared)"
                if resp.status_code != 200:
                    return None, f"Google Calendar answered HTTP {resp.status_code} for calendar '{calendar_id}'"
                body = resp.json()
                out.extend(body.get("items") or [])
                page_token = body.get("nextPageToken")
                if not page_token:
                    break
        return out, None
    finally:
        if owns_client:
            await client.aclose()
