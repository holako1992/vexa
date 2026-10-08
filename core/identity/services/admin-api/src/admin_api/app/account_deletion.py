"""Immediate, irreversible deletion of one account — identity orchestrates, every domain erases its own.

``DELETE /admin/users/{id}`` runs the stages below in order. The progress lives on the person's row
(``users.data.deletion``), so the operation is crash-safe and resumable: a repeat call skips what is
finished and carries on with the rest.

  1. lock         mark ``deletion.state = "deleting"`` and delete every ``api_tokens`` row. From then
                  on ``/internal/validate`` refuses the account, sign-in (find-or-create) refuses
                  it, and token minting refuses it, so nothing re-opens the account mid-deletion.
  2. billing      a live Stripe subscription is cancelled at once (no proration credit, no refund),
                  then the Stripe customer is deleted. Stripe unconfigured, or no customer: skipped.
  3. calendar     Google refresh tokens are revoked at Google (best-effort, logged). Microsoft's
                  identity platform has no per-token revocation endpoint, so a Microsoft grant is
                  only forgotten on our side. The connections go with the stored data.
  4. memberships  ``users.data.memberships[]`` is a rebuildable mirror and goes with the row. The
                  authoritative list is each workspace's own member file in the agent domain, which
                  agent-api's erasure settles (ownership transfer or removal).
  5. domains      meeting-api, agent-api and flows-api each erase what they hold for the account over
                  ``POST /internal/accounts/{id}/erase`` (idempotent, ``X-Internal-Secret``). The
                  ``subject`` agent-api and flows-api key a person by is ``str(users.id)`` — the
                  value the gateway injects as ``X-User-Id``. flows also receives the account's
                  address, because part of what it holds is keyed by address.
  6. identity     ``api_tokens`` and the ``users`` row are deleted, last.
  7. fact         ``account.deleted`` {subject} goes to flows — best-effort, carrying no address.

A failed stage leaves the account locked and answers ``502 {"error": "partial", "pending": [...]}``;
the same call again resumes. Logs carry the user id and the stage only.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import attributes

from ..schema.models import APIToken, User
from . import events as events_mod
from . import google_oauth, token_cipher
from .billing import plan_change as billing_plan_change
from .billing.stripe_gateway import StripeAPIError
from .calendars import connections_from_data

log = logging.getLogger("admin_api.account_deletion")

DELETION_KEY = "deletion"
STATE_DELETING = "deleting"

MEETING_API_URL_ENV = "VEXA_MEETING_API_URL"
AGENT_API_URL_ENV = "VEXA_AGENT_API_URL"
#: Where flows is erased. Separate from the publish edge (``VEXA_FLOWS_API_URL``), whose empty value
#: is a deliberate "publish nothing" profile: a stack that runs flows-api but publishes no facts to it
#: still holds the person's mail and reactions there, and they must go. Falls back to the publish
#: edge; with neither set the deployment carries no flows domain and the stage is skipped.
FLOWS_ERASE_URL_ENV = "VEXA_FLOWS_ERASE_URL"

#: A domain erasure can walk a lot of stored recordings, so this is far above the 2 s publish bound.
ERASE_TIMEOUT_S = 120.0

#: Everything under ``users.data`` the calendar stage owns.
_CALENDAR_KEYS = ("calendar_connections", "calendar_ics_url", "calendar_auto_join",
                  "calendar_bot_name", "google_oauth_nonces", "microsoft_oauth_nonces")


def deletion_of(data: Any) -> Optional[dict]:
    """The deletion record of a ``users.data`` blob, or None when the account is live."""
    rec = data.get(DELETION_KEY) if isinstance(data, dict) else None
    return rec if isinstance(rec, dict) and rec.get("state") == STATE_DELETING else None


def is_deleting(user: Any) -> bool:
    return deletion_of(getattr(user, "data", None)) is not None


class StageFailed(Exception):
    """A stage did not finish; the account stays locked and the call can be repeated."""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=ERASE_TIMEOUT_S)


def _stripe_gone(e: StripeAPIError) -> bool:
    return e.status_code == 404 or e.code == "resource_missing"


async def _erase_billing(user: User, stripe_factory: Callable[[], Any]) -> Dict[str, Any]:
    if not os.environ.get("STRIPE_SECRET_KEY"):
        return {"skipped": "stripe not configured"}
    data = user.data if isinstance(user.data, dict) else {}
    customer_id = data.get("stripe_customer_id")
    if not customer_id:
        return {"skipped": "no customer"}
    client = stripe_factory()
    cancelled = 0
    try:
        try:
            live = billing_plan_change.live_subscriptions(await client.list_subscriptions(customer_id))
        except StripeAPIError as e:
            if not _stripe_gone(e):
                raise
            return {"customer": "already gone"}
        for subscription in live:
            try:
                await client.cancel_subscription(subscription["id"])
                cancelled += 1
            except StripeAPIError as e:
                if not _stripe_gone(e):
                    raise
        try:
            await client.delete_customer(customer_id)
        except StripeAPIError as e:
            if not _stripe_gone(e):
                raise
    except Exception as e:  # noqa: BLE001 — surfaced as a pending stage, never swallowed
        raise StageFailed(f"Stripe: {getattr(e, 'message', None) or type(e).__name__}") from e
    return {"subscriptions_cancelled": cancelled, "customer_deleted": True}


async def _erase_calendar(user: User) -> Dict[str, Any]:
    data = user.data if isinstance(user.data, dict) else {}
    revoked = failed = unrevocable = 0
    for c in connections_from_data(data, user.id, include_deleted=True):
        kind = c.get("kind") or "ics"
        if kind == "microsoft" and c.get("microsoft_refresh_token_enc"):
            unrevocable += 1
        if kind != "google" or not c.get("google_refresh_token_enc"):
            continue
        try:
            refresh_token = token_cipher.decrypt(
                c["google_refresh_token_enc"], user_id=user.id, calendar_id=c["id"])
            await google_oauth.revoke_token(token=refresh_token)
            revoked += 1
        except Exception:  # noqa: BLE001 — best-effort: the stored copy is deleted regardless
            failed += 1
            log.warning("account-deletion user=%s calendar revoke failed", user.id)
    return {"google_revoked": revoked, "google_revoke_failed": failed,
            "microsoft_not_revocable": unrevocable}


async def _erase_remote(name: str, base: str, user: User, body: Optional[dict],
                        *, optional: bool) -> Dict[str, Any]:
    if not base:
        if optional:
            return {"skipped": "not configured"}
        raise StageFailed(f"{name}: service URL is not configured")
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    headers = {"X-Internal-Secret": secret} if secret else {}
    url = f"{base.rstrip('/')}/internal/accounts/{user.id}/erase"
    try:
        async with _client() as client:
            r = await client.post(url, headers=headers, json=body or {})
    except Exception as e:  # noqa: BLE001
        raise StageFailed(f"{name}: unreachable ({type(e).__name__})") from e
    if r.status_code != 200:
        stage = ""
        try:
            payload = r.json()
            stage = str(payload.get("stage") or payload.get("error") or "")
        except Exception:  # noqa: BLE001
            pass
        raise StageFailed(f"{name}: HTTP {r.status_code}" + (f" at {stage}" if stage else ""))
    try:
        erased = r.json().get("erased")
    except Exception:  # noqa: BLE001
        erased = None
    return erased if isinstance(erased, dict) else {}


async def _record(db: AsyncSession, user_id: int, part: str, summary: Dict[str, Any],
                  strip: Tuple[str, ...] = ()) -> None:
    """Persist one finished stage on the row (and drop the data it owned), in its own commit."""
    user = (await db.execute(select(User).where(User.id == user_id).with_for_update())).scalar_one()
    data = dict(user.data or {})
    for key in strip:
        data.pop(key, None)
    rec = dict(data.get(DELETION_KEY) or {})
    rec["done"] = [*[p for p in rec.get("done") or [] if p != part], part]
    rec["erased"] = {**(rec.get("erased") or {}), part: summary}
    data[DELETION_KEY] = rec
    user.data = data
    attributes.flag_modified(user, "data")
    await db.commit()


async def delete_account(user_id: int, db: AsyncSession, *,
                         stripe_factory: Callable[[], Any]) -> Tuple[int, Dict[str, Any]]:
    """Run (or resume) the deletion. Returns ``(http_status, body)``."""
    user = (await db.execute(select(User).where(User.id == user_id).with_for_update())).scalar_one_or_none()
    if user is None:
        return 404, {"detail": "User not found"}

    data = dict(user.data or {})
    if deletion_of(data) is None:
        if data.get("is_admin") is True:
            others = (await db.execute(
                select(func.count()).select_from(User)
                .where(User.id != user_id, User.data["is_admin"].astext == "true")
            )).scalar_one()
            if not others:
                await db.rollback()
                return 409, {"error": "last_admin",
                             "detail": "This is the instance's only admin; deleting it would let "
                                       "the next sign-in claim the admin role. Make another "
                                       "account an admin first."}
        data[DELETION_KEY] = {"state": STATE_DELETING, "started_at": time.time(),
                              "done": [], "erased": {}, "tokens_revoked": 0}
        user.data = data
        attributes.flag_modified(user, "data")
        log.info("account-deletion user=%s stage=lock", user_id)

    revoked = (await db.execute(delete(APIToken).where(APIToken.user_id == user_id))).rowcount or 0
    if revoked:
        rec = dict(user.data[DELETION_KEY])
        rec["tokens_revoked"] = int(rec.get("tokens_revoked") or 0) + revoked
        user.data = {**user.data, DELETION_KEY: rec}
        attributes.flag_modified(user, "data")
    await db.commit()
    await db.refresh(user)

    email = (user.email or "").strip().lower()
    memberships = user.data.get("memberships")
    n_memberships = len(memberships) if isinstance(memberships, list) else 0

    async def billing() -> Dict[str, Any]:
        return await _erase_billing(user, stripe_factory)

    async def calendar() -> Dict[str, Any]:
        return await _erase_calendar(user)

    async def memberships_stage() -> Dict[str, Any]:
        return {"mirror_entries_removed": n_memberships}

    async def meetings() -> Dict[str, Any]:
        return await _erase_remote("meetings", os.environ.get(MEETING_API_URL_ENV, ""), user, None,
                                   optional=False)

    async def agent() -> Dict[str, Any]:
        return await _erase_remote("agent", os.environ.get(AGENT_API_URL_ENV, ""), user, None,
                                   optional=False)

    async def flows() -> Dict[str, Any]:
        base = os.environ.get(FLOWS_ERASE_URL_ENV, "").strip() or events_mod._flows_base()
        return await _erase_remote("flows", base, user,
                                   {"emails": [email]} if email else None, optional=True)

    stages: List[Tuple[str, Callable[[], Awaitable[Dict[str, Any]]], Tuple[str, ...]]] = [
        ("billing", billing, ()),
        ("calendar", calendar, _CALENDAR_KEYS),
        ("memberships", memberships_stage, ("memberships",)),
        ("meetings", meetings, ()),
        ("agent", agent, ()),
        ("flows", flows, ()),
    ]
    pending: List[str] = []
    details: List[str] = []
    for name, run, strip in stages:
        if name in (user.data[DELETION_KEY].get("done") or []):
            continue
        try:
            summary = await run()
        except StageFailed as e:
            pending.append(name)
            details.append(str(e))
            log.error("account-deletion user=%s stage=%s failed", user_id, name)
            continue
        await _record(db, user_id, name, summary, strip)
        await db.refresh(user)
        log.info("account-deletion user=%s stage=%s done", user_id, name)

    if pending:
        return 502, {"error": "partial", "pending": pending, "detail": "; ".join(details)}

    rec = user.data[DELETION_KEY]
    erased = dict(rec.get("erased") or {})
    tokens_revoked = int(rec.get("tokens_revoked") or 0)
    await db.execute(delete(APIToken).where(APIToken.user_id == user_id))
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()
    log.info("account-deletion user=%s stage=identity done", user_id)

    try:
        await events_mod.publish(events_mod.EVENT_ACCOUNT_DELETED,
                                 events_mod.account_deleted_source_id(user_id),
                                 events_mod.account_deleted_refs(user_id))
    except Exception:  # noqa: BLE001 — a publish edge is not a dependency
        pass

    return 200, {
        "status": "deleted",
        "user_id": user_id,
        "erased": {
            "identity": {"user": 1, "tokens_revoked": tokens_revoked,
                         "billing": erased.get("billing", {}),
                         "calendar": erased.get("calendar", {}),
                         "memberships": erased.get("memberships", {})},
            "meetings": erased.get("meetings", {}),
            "agent": erased.get("agent", {}),
            "flows": erased.get("flows", {}),
        },
    }
