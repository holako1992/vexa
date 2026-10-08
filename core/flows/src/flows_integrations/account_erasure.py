"""Account erasure for the flows domain — everything flows holds for ONE person, gone, and nothing queued
that could still act for them.

The identity service orchestrates account deletion: it locks the account, asks each domain to erase what
it holds, then deletes the user row. This is flows' part, reached through flows-api's internal
``POST /internal/accounts/{subject}/erase``. ``subject`` is the platform user id as flows keys it
(``refs.uid`` · ``refs.subject`` · ``mail_thread.subject_uid`` …) — the stringified ``users.id``.

A person is held under TWO identifiers and neither is enough alone (the same reason
``flows_timeline.model.concerns`` scopes on both): the completed lineage carries a uid and no address, the
invite lineage an organizer address and no uid, and the mailbox policy tables (``mail_quarantine``,
``mail_turn``) are keyed by sender address alone. The addresses come from the caller (``emails``) and from
admin-api's record of the account, asked while the row still exists.

What counts as THEIRS is narrower than ``concerns``: a reaction keyed to the person as subject, owner or
organizer is theirs and is erased; a reaction that merely lists them among ``participants``/``attendees``
belongs to the organizer and is left alone. Erasing the first is the request; erasing the second would
destroy someone else's meeting.

Order is what makes a crash resumable. Queued work is cancelled first (nothing leased afterwards, nothing
sent for them), then each reaction's receipts and signals go before the reaction row, then the tables keyed
by uid or address. Every stage discovers its own work by query, so a retry finishes the job and an erased
account answers with zero counts.

Not erasable here, by design: ``mail_cursor`` and ``mail_seen`` are the poller's position and the ids it has
routed — they hold no person. A reaction a step is executing at the moment of the call can still finish its
send; the step reads the address from admin-api at send time, so once identity deletes the user row it
resolves nothing and skips."""
from __future__ import annotations

from typing import Callable, Iterable

from flows.db import DB, loads
from flows_timeline.model import _emails

#: refs keys that name the person as the fact's SUBJECT — the reaction is theirs.
_UID_KEYS = ("uid", "user_id", "subject", "owner")
#: refs keys that name a single address as the fact's own party — the reaction is theirs. The list-valued
#: keys (participants · attendees · recipients) are deliberately absent: those reactions belong to someone else.
_ADDRESS_KEYS = ("organizer", "inviter", "from", "to", "recipient", "email")
#: Statuses that can still cause work.
_LIVE = ("admitted", "running", "blocked", "retrying")


class ErasureError(RuntimeError):
    """A stage failed; ``stage`` names it so the caller reports exactly what was not finished."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


def owns(refs: dict, uid: str, emails: Iterable[str]) -> bool:
    """Is this reaction the person's own (see the module docstring for what that excludes)?"""
    if any(str(refs.get(k) or "").strip() == uid for k in _UID_KEYS):
        return True
    mine = set(emails)
    return bool(mine) and any(set(_emails(refs.get(k))) & mine for k in _ADDRESS_KEYS)


def _count(db: DB, sql: str, params: dict) -> int:
    rows = db.execute(sql, params)
    return int(rows[0][0]) if rows else 0


def _in(prefix: str, values: list[str]) -> tuple[str, dict]:
    names = [f"{prefix}{i}" for i in range(len(values))]
    return ", ".join(f":{n}" for n in names), dict(zip(names, values))


def erase_account(db: DB, uid: str, *, emails: Iterable[str] = (), now: float,
                  on_stage: Callable[[str], None] | None = None) -> dict[str, int]:
    """Erase the person's footprint; return ``{what: count}``. Raises ``ErasureError(stage, …)`` on the first
    failing stage — completed stages stay completed and a retry resumes."""
    uid = str(uid).strip()
    addrs = sorted({e.strip().lower() for e in emails if e and e.strip()})
    erased: dict[str, int] = {}
    stage_name = "start"

    def stage(name: str) -> None:
        nonlocal stage_name
        stage_name = name
        if on_stage:
            on_stage(name)

    try:
        stage("find")
        # `subject_refs` is a JSON blob with no index to push a predicate into: prefilter on the text so a
        # large table is not loaded whole, then decide ownership exactly on the parsed refs.
        clauses, params = ["subject_refs LIKE :uid"], {"uid": f"%{uid}%"}
        for i, a in enumerate(addrs):
            clauses.append(f"lower(subject_refs) LIKE :a{i}")
            params[f"a{i}"] = f"%{a}%"
        rows = db.execute(f"SELECT reaction_id, subject_refs, status FROM reaction WHERE {' OR '.join(clauses)}",
                          params)
        mine = [(rid, status) for rid, refs, status in rows if owns(loads(refs), uid, addrs)]

        stage("cancel")
        cancelled = 0
        for rid, status in mine:
            if status in _LIVE:
                db.execute("""UPDATE reaction SET status = 'cancelled', reason = 'account erased',
                                     lease_until = NULL, blocked_deadline = NULL, updated_at = :now
                              WHERE reaction_id = :rid AND status IN ('admitted','running','blocked','retrying')""",
                           {"now": now, "rid": rid})
                cancelled += 1
        erased["reactions_cancelled"] = cancelled

        stage("reactions")
        receipts = signals = 0
        for rid, _status in mine:
            receipts += _count(db, "SELECT COUNT(*) FROM effect_receipt WHERE reaction_id = :r", {"r": rid})
            signals += _count(db, "SELECT COUNT(*) FROM signal WHERE reaction_id = :r", {"r": rid})
            db.execute("DELETE FROM effect_receipt WHERE reaction_id = :r", {"r": rid})
            db.execute("DELETE FROM signal WHERE reaction_id = :r", {"r": rid})
            db.execute("DELETE FROM reaction WHERE reaction_id = :r", {"r": rid})
        erased["reactions"], erased["receipts"], erased["signals"] = len(mine), receipts, signals

        stage("mail")
        for table, col, key in (("mail_thread", "subject_uid", "mail_threads"),
                                ("mail_outbox_sent", "subject_uid", "mail_outbox_sent")):
            erased[key] = _count(db, f"SELECT COUNT(*) FROM {table} WHERE {col} = :u", {"u": uid})
            db.execute(f"DELETE FROM {table} WHERE {col} = :u", {"u": uid})
        for table, key in (("mail_quarantine", "mail_quarantine"), ("mail_turn", "mail_turns")):
            if addrs:
                marks, p = _in("m", addrs)
                erased[key] = _count(db, f"SELECT COUNT(*) FROM {table} WHERE from_addr IN ({marks})", p)
                db.execute(f"DELETE FROM {table} WHERE from_addr IN ({marks})", p)
            else:
                erased[key] = 0
    except ErasureError:
        raise
    except Exception as exc:  # noqa: BLE001 — typed to the stage; the caller reports it, a retry resumes
        raise ErasureError(stage_name, f"{type(exc).__name__}: {exc}") from exc
    return erased
