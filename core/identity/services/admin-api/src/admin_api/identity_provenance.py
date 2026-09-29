"""Sign-in provenance — how an account proved its email address.

The record lives in the user's `users.data` JSON blob under one key, no schema migration:

    data["identity"] = {"provider": "google" | "microsoft" | "email",
                        "email_verified": bool,
                        "verified_at": "<iso8601 UTC>"}      # present only when verified

`provider` is the door the account came through; `email_verified` is that door's claim that the
person controls the address (Google's `email_verified` claim; Microsoft Entra accounts are
verified by the tenant; the dev email door proves nothing, so it says `false`).

Two rules this module owns, so no caller has to remember them:

  * A recorded `email_verified: true` is never downgraded. A later, weaker claim (the dev email
    door signing in an account Google already verified) leaves the record as it is.
  * An account with NO record is not "unverified" — it is unknown (accounts created before the
    record existed, terminal- and API-created users). `is_explicitly_unverified` is true only for
    a stored `email_verified: false`, which is what the Free-plan allowance gate reads.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

#: The closed set of sign-in doors. A body naming anything else is refused at the edge.
IDENTITY_PROVIDERS = ("google", "microsoft", "email")

#: The `users.data` key the record is stored under.
IDENTITY_KEY = "identity"


def merge_identity(
    data: Dict[str, Any], provider: str, email_verified: bool, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """`data` with the identity record set or upgraded from this claim (a new dict; the input is
    not mutated). A stored verified record wins over any claim; otherwise the claim replaces the
    stored record."""
    current = data.get(IDENTITY_KEY)
    if isinstance(current, dict) and current.get("email_verified") is True:
        return dict(data)
    record: Dict[str, Any] = {"provider": provider, "email_verified": bool(email_verified)}
    if email_verified:
        record["verified_at"] = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
    return {**data, IDENTITY_KEY: record}


def is_explicitly_unverified(data: Dict[str, Any]) -> bool:
    """True only when a record exists and says `email_verified` is `false`."""
    record = data.get(IDENTITY_KEY) if isinstance(data, dict) else None
    return isinstance(record, dict) and record.get("email_verified") is False
