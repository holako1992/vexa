"""FIRST RUN — where a new account stands in the dashboard's three-step welcome, and the only
place that fact lives.

WHY IDENTITY. "Is this a new account, and has it finished or skipped the welcome?" is a fact about a
PERSON that has to survive a refresh, a second browser and a second device. A cookie or
`localStorage` in the client answers it for one browser only, so the same person would be welcomed
again on every machine they sign in from. Identity already stamps the moment an account came to
exist (`users.data.onboarding_completed_at`, written in the same transaction as the account — see
`create_user`), so the welcome's state sits beside that stamp.

WHO IS NEW. An account is new when it carries that stamp AND the stamp is younger than
`WINDOW_SECONDS`. An account without the stamp predates it, and one older than the window has been
using the product for a while; neither is welcomed, whatever its meeting count. "Zero meetings" is
NOT the test — a person who deleted their meetings is not new — and the meetings count is not
identity's to know, so the client adds it as one further condition on top of `active`.

THE RECORD, ``users.data.first_run``, holds at most ``{"step": <STEPS>, "state": <ENDED>}``:

  * no record, and new      -> ``active`` at the first step.
  * ``step`` only           -> ``active`` at that step; a refresh resumes here.
  * ``state`` done/skipped  -> that state, for good. An ended welcome is never re-opened: a later
    write is answered with the record as it stands, not refused, so a second tab that finishes
    after the first is a no-op rather than an error.
  * not new, no record      -> ``none``.

THE VOCABULARY IS CLOSED. An unknown field, step or state is refused WITH the list of what exists.
"""
from __future__ import annotations

from typing import Any, Dict

DATA_KEY = "first_run"
#: The stamp `create_user` writes with the account. Seconds since the epoch.
CREATED_KEY = "onboarding_completed_at"

#: How long after sign-up an account still counts as new.
WINDOW_SECONDS = 7 * 24 * 3600

#: The welcome's steps, in order: the bot's display name, a calendar, a first meeting link.
STEPS = ("name", "calendar", "meeting")
ENDED = ("done", "skipped")
FIELDS = ("step", "state")

ACTIVE, NONE = "active", "none"


class Refused(ValueError):
    """A body the vocabulary does not accept. ``detail`` is safe to return to the caller."""

    def __init__(self, detail: dict) -> None:
        super().__init__(str(detail))
        self.detail = detail


def _vocabulary() -> dict:
    return {"step": list(STEPS), "state": list(ENDED)}


def _is_new(data: dict, now: float) -> bool:
    stamp = data.get(CREATED_KEY)
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return False
    return 0 <= now - stamp <= WINDOW_SECONDS


def _record(data: dict) -> dict:
    raw = data.get(DATA_KEY)
    return raw if isinstance(raw, dict) else {}


def read(data: dict | None, now: float) -> Dict[str, Any]:
    """``{"state": active|done|skipped|none, "step": <STEPS>}`` for this person. Never raises.

    ``step`` is always present and always a real step, so a caller never branches on a missing key."""
    data = data or {}
    rec = _record(data)
    step = rec.get("step") if rec.get("step") in STEPS else STEPS[0]
    if rec.get("state") in ENDED:
        return {"state": rec["state"], "step": step}
    if _is_new(data, now):
        return {"state": ACTIVE, "step": step}
    return {"state": NONE, "step": step}


def apply(data: dict | None, update: Any, now: float) -> dict:
    """The new ``users.data`` after ``update`` (``{"step"?, "state"?}``), validated whole before
    anything is written. An ended welcome answers with ``data`` unchanged; an account that is not
    new has no welcome to write to and is refused."""
    if not isinstance(update, dict) or not update:
        raise Refused({"refused": "give a step or a state", "the_fields_that_exist": _vocabulary()})
    unknown = sorted(str(k) for k in update if k not in FIELDS)
    if unknown:
        raise Refused({"refused": f"there is no field called {unknown[0]!r}",
                       "the_fields_that_exist": _vocabulary()})
    if "step" in update and update["step"] not in STEPS:
        raise Refused({"refused": f"{update['step']!r} is not a step", "steps": list(STEPS)})
    if "state" in update and update["state"] not in ENDED:
        raise Refused({"refused": f"{update['state']!r} is not a way to end the welcome",
                       "states": list(ENDED)})
    data = dict(data or {})
    current = read(data, now)["state"]
    if current in ENDED:
        return data
    if current == NONE:
        raise Refused({"refused": "this account has no first-run welcome"})
    data[DATA_KEY] = {**_record(data), **update}
    return data
