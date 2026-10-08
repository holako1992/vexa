"""Account erasure (flows domain): ``POST /internal/accounts/{subject}/erase``.

Offline: a real sqlite schema with rows written the way the engine and the mail policy write them, behind
the real route. Proves: person A's rows are gone (reactions they own, receipts, signals, mail threads,
outbox dedupe, address-keyed quarantine and turn rows), person B's are untouched — including a reaction of
B's that merely lists A as an attendee — queued work is cancelled so nothing can send for A, a second call
returns zero counts, a mid-way failure answers 5xx and a retry completes, and the auth gate fails closed.
"""
from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from sqlite_double import SqliteDB

# `flows_api` reads its credentials and composes its database AT IMPORT, so it is imported lazily in a
# fixture that sets the same environment the sibling suites set and restores it — a module-level import
# here would run at collection and pre-empt their fixtures as the first importer.
_ENV = {"VEXA_FLOWS_API_KEY": "test-flows-key",
        "INTERNAL_API_SECRET": "test-internal-secret",
        "VEXA_FLOWS_DB_URL": "postgresql+psycopg://account-erasure:unreachable@127.0.0.1:1/flows"}


@pytest.fixture(scope="module")
def flows_api():
    saved = {k: os.environ.get(k) for k in _ENV}
    os.environ.update(_ENV)
    try:
        from flows_integrations import flows_api as module
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return module


SECRET = "the-internal-secret"
HDR = {"X-Internal-Secret": SECRET}
A, B = "126", "204"
A_MAIL, B_MAIL = "alice@example.test", "bob@example.test"
T0 = 1_788_000_000.0


def _reaction(db, rid, refs, *, status="done", event="meeting.completed"):
    db.execute("""INSERT INTO reaction (reaction_id, source_event_id, event_type, subject_refs, flow,
                                        flow_version, step, status, attempt, next_run_at, lease_until,
                                        created_at, updated_at)
                  VALUES (:rid,:sid,:ev,:refs,'post_meeting',1,'email_owner_ready',:st,0,:t,:lease,:t,:t)""",
               {"rid": rid, "sid": f"{rid}::post_meeting", "ev": event, "refs": json.dumps(refs),
                "st": status, "t": T0, "lease": T0 + 60 if status == "running" else None})
    db.execute("""INSERT INTO effect_receipt (effect_key, reaction_id, step, state, attempted_at)
                  VALUES (:k,:r,'email_owner_ready','confirmed',:t)""", {"k": f"{rid}:s", "r": rid, "t": T0})
    db.execute("""INSERT INTO signal (signal_id, reaction_id, kind, actor, created_at)
                  VALUES (:s,:r,'wake','api',:t)""", {"s": f"sig-{rid}", "r": rid, "t": T0})


def _world() -> SqliteDB:
    db = SqliteDB()
    _reaction(db, "a-done", {"uid": A, "meeting_id": 1})
    _reaction(db, "a-queued", {"uid": A, "meeting_id": 2}, status="admitted")        # meeting-ready mail due
    _reaction(db, "a-retry", {"uid": A, "meeting_id": 3}, status="retrying")
    _reaction(db, "a-running", {"uid": A, "meeting_id": 4}, status="running")
    _reaction(db, "a-dunning", {"subject": A, "invoice_id": "in_1"}, status="admitted",
              event="payment.failed")
    _reaction(db, "a-invite", {"organizer": A_MAIL.upper(), "title": "from the invite"}, status="blocked",
              event="invite.received")
    _reaction(db, "b-done", {"uid": B, "meeting_id": 9})
    _reaction(db, "b-queued", {"uid": B, "meeting_id": 10}, status="admitted")
    _reaction(db, "b-with-a-attending", {"uid": B, "organizer": B_MAIL, "participants": [A_MAIL, B_MAIL],
                                         "attendees": [{"email": A_MAIL}]}, status="admitted")
    _reaction(db, "b-uid-substring", {"uid": "1260"}, status="admitted")             # '126' inside '1260'
    for mid, uid, sess in (("<m1@x>", A, "meeting-ready-1"), ("<m2@x>", B, "meeting-ready-9")):
        db.execute("INSERT INTO mail_thread VALUES (:m,:u,:s,:t)", {"m": mid, "u": uid, "s": sess, "t": T0})
    for uid, sess in ((A, "meeting-ready-1"), (A, "payment-failed-in_1"), (B, "meeting-ready-9")):
        db.execute("INSERT INTO mail_outbox_sent VALUES (:u,:s,'v1',:t)", {"u": uid, "s": sess, "t": T0})
    for ext, frm in (("q1", A_MAIL), ("q2", B_MAIL)):
        db.execute("INSERT INTO mail_quarantine (ext_id, from_addr, kind, reason, at) "
                   "VALUES (:e,:f,'invite','stranger',:t)", {"e": ext, "f": frm, "t": T0})
    for ext, frm in (("t1", A_MAIL), ("t2", A_MAIL), ("t3", B_MAIL)):
        db.execute("INSERT INTO mail_turn VALUES (:e,:f,:t)", {"e": ext, "f": frm, "t": T0})
    db.execute("INSERT INTO mail_cursor (id, uid) VALUES (1, 77)")
    return db


def _count(db, table, where="1=1", **p):
    return int(db.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", p)[0][0])


@pytest.fixture
def env(monkeypatch, flows_api):
    db = _world()
    monkeypatch.setattr(flows_api, "db", db)
    monkeypatch.setattr(flows_api, "INTERNAL_SECRET", SECRET)
    monkeypatch.setattr(flows_api, "_account_emails", lambda uid: [A_MAIL] if uid == A else [])
    return db, TestClient(flows_api.app, raise_server_exceptions=False)


def _erase(client, subject=A, headers=HDR, **kw):
    return client.post(f"/internal/accounts/{subject}/erase", headers=headers, **kw)


def test_erases_person_a_and_leaves_person_b_intact(env):
    db, client = env
    r = _erase(client)
    assert r.status_code == 200, r.text
    assert r.json()["subject"] == A
    e = r.json()["erased"]
    assert e["reactions"] == 6 and e["receipts"] == 6 and e["signals"] == 6
    assert e["reactions_cancelled"] == 5            # admitted ×2, retrying, running, blocked
    assert e["mail_threads"] == 1 and e["mail_outbox_sent"] == 2
    assert e["mail_quarantine"] == 1 and e["mail_turns"] == 2

    assert _count(db, "reaction", "reaction_id LIKE 'a-%'") == 0
    assert _count(db, "effect_receipt", "reaction_id LIKE 'a-%'") == 0
    assert _count(db, "signal", "reaction_id LIKE 'a-%'") == 0
    assert _count(db, "mail_thread", "subject_uid = :u", u=A) == 0
    assert _count(db, "mail_outbox_sent", "subject_uid = :u", u=A) == 0
    assert _count(db, "mail_quarantine", "from_addr = :f", f=A_MAIL) == 0
    assert _count(db, "mail_turn", "from_addr = :f", f=A_MAIL) == 0

    # B untouched — including the reaction that only LISTS A as an attendee, and the uid that contains A's
    assert _count(db, "reaction") == 4
    assert {r[0] for r in db.execute("SELECT reaction_id FROM reaction")} == {
        "b-done", "b-queued", "b-with-a-attending", "b-uid-substring"}
    assert {r[0] for r in db.execute("SELECT status FROM reaction WHERE reaction_id LIKE 'b-%'")} <= {
        "done", "admitted"}
    assert _count(db, "effect_receipt") == 4 and _count(db, "signal") == 4
    assert _count(db, "mail_thread") == 1 and _count(db, "mail_outbox_sent") == 1
    assert _count(db, "mail_quarantine", "from_addr = :f", f=B_MAIL) == 1
    assert _count(db, "mail_turn", "from_addr = :f", f=B_MAIL) == 1
    assert _count(db, "mail_cursor") == 1           # the poller's position holds no person


def test_nothing_queued_for_a_survives_to_be_claimed(env):
    """The property that matters: after the call there is no due reaction naming A for the loop to claim."""
    from flows.loop import claim
    from flows.clock import SystemClock
    db, client = env
    assert _erase(client).status_code == 200
    claimed = []
    clock = SystemClock()
    while (r := claim(db, clock)) is not None:
        claimed.append(r.reaction_id)
    assert claimed and all(c.startswith("b-") for c in claimed)


def test_a_cancelled_queue_is_cancelled_before_it_is_deleted(env, monkeypatch):
    """A crash after the cancel stage leaves A's work cancelled (nothing to claim), not live."""
    db, client = env
    from flows_integrations import account_erasure
    real = account_erasure.erase_account

    def stop_after_cancel(db_, uid, **kw):
        def on_stage(name):
            if name == "reactions":
                raise RuntimeError("process died")
        return real(db_, uid, on_stage=on_stage, **kw)

    monkeypatch.setattr(account_erasure, "erase_account", stop_after_cancel)
    r = _erase(client)
    assert r.status_code == 500 and r.json()["stage"] == "reactions"
    live = db.execute("SELECT reaction_id FROM reaction WHERE reaction_id LIKE 'a-%' "
                      "AND status IN ('admitted','retrying','running','blocked')")
    assert live == []
    assert _count(db, "reaction", "reaction_id LIKE 'a-%'") == 6      # not yet deleted — and not claimable


def test_second_call_returns_zero_counts(env):
    db, client = env
    assert _erase(client).status_code == 200
    again = _erase(client)
    assert again.status_code == 200
    assert set(again.json()["erased"].values()) == {0}
    assert _count(db, "reaction") == 4


def test_mid_way_failure_is_5xx_and_retry_completes(env, monkeypatch):
    db, client = env
    real_execute = db.execute
    state = {"armed": True}

    def flaky(sql, params=None):
        if state["armed"] and sql.startswith("DELETE FROM mail_outbox_sent"):
            raise RuntimeError("connection reset")
        return real_execute(sql, params)

    monkeypatch.setattr(db, "execute", flaky)
    r = _erase(client)
    assert r.status_code == 500
    assert r.json()["stage"] == "mail" and "error" in r.json() and "erased" not in r.json()
    assert _count(db, "reaction", "reaction_id LIKE 'a-%'") == 0       # completed stages stay completed
    assert _count(db, "mail_outbox_sent", "subject_uid = :u", u=A) == 2   # the failed stage did not complete
    state["armed"] = False
    r = _erase(client)
    assert r.status_code == 200
    assert _count(db, "mail_outbox_sent", "subject_uid = :u", u=A) == 0
    assert _count(db, "mail_quarantine", "from_addr = :f", f=A_MAIL) == 0
    assert _count(db, "mail_turn", "from_addr = :f", f=A_MAIL) == 0


def test_unresolvable_account_address_is_a_failure_not_a_skip(env, flows_api, monkeypatch):
    db, client = env

    def down(uid):
        raise RuntimeError("admin-api answered 502 for the account lookup")

    monkeypatch.setattr(flows_api, "_account_emails", down)
    r = _erase(client)
    assert r.status_code == 500 and r.json()["stage"] == "resolve_email"
    assert _count(db, "reaction", "reaction_id LIKE 'a-%'") == 6 and _count(db, "mail_turn") == 3


def test_caller_supplied_addresses_scope_the_address_keyed_tables(env, flows_api, monkeypatch):
    db, client = env
    monkeypatch.setattr(flows_api, "_account_emails", lambda uid: [])
    r = _erase(client, json={"emails": ["ALICE@example.test"]})
    assert r.status_code == 200
    assert r.json()["erased"]["mail_turns"] == 2 and r.json()["erased"]["mail_quarantine"] == 1


@pytest.mark.parametrize("headers, status", [
    ({}, 403), ({"X-Internal-Secret": "wrong"}, 403), ({"X-Internal-Secret": ""}, 403),
    ({"X-Flows-Operator-Key": "test-flows-key"}, 403),     # the operator key is not the internal tier
])
def test_auth_fails_closed_and_touches_nothing(env, headers, status):
    db, client = env
    assert _erase(client, headers=headers).status_code == status
    assert _count(db, "reaction") == 10


def test_unset_secret_is_503(env, flows_api, monkeypatch):
    db, client = env
    monkeypatch.setattr(flows_api, "INTERNAL_SECRET", "")
    for hdr in ({}, {"X-Internal-Secret": ""}, {"X-Internal-Secret": "anything"}):
        assert _erase(client, headers=hdr).status_code == 503
    assert _count(db, "reaction") == 10


@pytest.mark.parametrize("subject", ["a-b", "x%27y", "..", "1;2"])
def test_unsafe_subjects_are_rejected(env, subject):
    db, client = env
    assert _erase(client, subject=subject).status_code in (400, 404)
    assert _count(db, "reaction") == 10


def test_the_route_is_not_an_mcp_tool(flows_api):
    manifest = json.dumps(flows_api.mcp_tools_manifest())
    assert "erase" not in manifest and "/internal/" not in manifest
