"""Account erasure (agent domain): ``POST /internal/accounts/{subject}/erase``.

Offline L2 over fakes (fakeredis, an in-memory scheduler + unit reaper, real git workspaces in tmp):
user A's footprint is gone, user B's is untouched (including a shared workspace B owns that A belonged
to), a second call returns zero counts, a mid-way failure answers 5xx and a retry completes, and the auth
gate fails closed.
"""
from __future__ import annotations

from pathlib import Path

import fakeredis
import pytest
from fastapi.testclient import TestClient

from control_plane import workspace_membership as m
from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from control_plane.workspace_reader import WorkspaceReader
from shared.config import load_settings
from tests.test_routines import _FakeScheduler
from tests.test_workspace_membership import _FakeIdentity, _FakeRuntime, _init_ws

A, B = "11", "22"
SECRET = "s3cret"
HDR = {"X-Internal-Secret": SECRET}


class _Reaper:
    def __init__(self, ids):
        self.ids = list(ids)
        self.fail_on: str | None = None

    def list_ids(self):
        return list(self.ids)

    def destroy(self, wid):
        if wid == self.fail_on:
            raise RuntimeError("kernel unreachable")
        self.ids.remove(wid)


def _job(owner: str, name: str) -> dict:
    return {"cron": "0 8 * * *", "request": {"method": "POST", "url": "http://x/invocations", "body": {}},
            "metadata": {"routine_id": f"rt_{owner}_{name}", "owner": owner, "name": name}}


def _private(root: Path, subject: str) -> None:
    (root / subject / "kg").mkdir(parents=True)
    (root / subject / "kg" / "note.md").write_text(f"{subject} secret\n")
    (root / ".attached" / subject / "slot-1").mkdir(parents=True)
    (root / ".attached" / subject / "slot-1" / "f.md").write_text("x")
    (root / ".attached" / subject / "state.json").write_text("{}")
    (root / ".system" / subject / "sessions").mkdir(parents=True)
    (root / ".system" / subject / "summary.md").write_text("summary")
    (root / ".secrets").mkdir(exist_ok=True)
    (root / ".secrets" / f"{subject}.ghtoken").write_text("ghp_x")


class Env:
    def __init__(self, tmp_path: Path):
        self.root = tmp_path
        self.index = m.InMemoryMembershipIndex()
        self.redis = fakeredis.FakeStrictRedis(decode_responses=True)
        self.scheduler = _FakeScheduler()
        self.reaper = _Reaper(["agent-11-chat-main", "agent-11-scheduled-abc", "agent-110-chat-main",
                               "agent-22-chat-main", "agent-meet-77"])
        for s in (A, B):
            _private(self.root, s)
        for owner, name in ((A, "brief"), (A, "digest"), (B, "brief")):
            self.scheduler.schedule(_job(owner, name))
        for ws, owner, members in (
            ("team-b", B, [(A, "contributor")]),                      # B owns, A is a member
            ("proj-a", A, [(B, "contributor")]),                      # A owns, B is a member
            ("proj-a2", A, [(B, "viewer"), ("33", "contributor")]),   # a contributor outranks a viewer
            ("solo-a", A, []),                                        # only A
            ("joint", A, [(B, "owner")]),                             # co-owned already
        ):
            _init_ws(self.root, ws)
            (self.root / ws / "data.md").write_text(f"{ws} content\n")
            m.ensure_owner(self.root, ws, owner, index=self.index, commit_fn=m.policy_commit)
            for subj, role in members:
                m.grant_membership(self.root, ws, subj, role, added_by=owner, index=self.index,
                                   commit_fn=m.policy_commit)
        m.mint_invite(self.root, "team-b", role="contributor", created_by=A, commit_fn=m.policy_commit)
        for k in ("agent:sessions:11", "agent:session:11:main", "agent:sessions:22", "agent:session:22:main",
                  "unit:agent-11-chat-main:out", "unit:agent-11-chat-main:in", "unit:agent-11-chat-main:turnhead",
                  "unit:agent-110-chat-main:out", "unit:agent-22-chat-main:out", "proc:meeting:5"):
            self.redis.set(k, "1")
        self.client = self.make_client()

    def make_client(self, secret=SECRET):
        return TestClient(create_app(
            Dispatcher(load_settings(internal_api_secret=secret), _FakeRuntime(), _FakeIdentity()),
            reader=WorkspaceReader(str(self.root)), scheduler=self.scheduler, membership_index=self.index,
            unit_reaper=self.reaper, erasure_redis=self.redis,
        ), raise_server_exceptions=False)

    def erase(self, subject=A, headers=HDR):
        return self.client.post(f"/internal/accounts/{subject}/erase", headers=headers)

    def members(self, ws):
        return {x["subject"]: x["role"] for x in m.read_members(self.root, ws)}


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def test_erases_user_a_and_leaves_user_b_intact(env):
    r = env.erase()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["subject"] == A
    e = body["erased"]
    assert e["routine_jobs"] == 2 and e["units"] == 2
    assert e["private_workspaces"] == 2 and e["system_workspaces"] == 1 and e["credentials"] == 1
    assert e["shared_workspaces_deleted"] == 1       # solo-a
    assert e["shared_memberships_removed"] == 4      # team-b, proj-a, proj-a2, joint
    assert e["shared_ownership_transferred"] == 2    # proj-a, proj-a2 (joint already has B as owner)
    assert e["invites_revoked"] == 1
    assert e["redis_keys"] == 5                      # 2 session keys + 3 unit keys

    root = env.root
    for p in (root / A, root / ".attached" / A, root / ".system" / A, root / ".secrets" / f"{A}.ghtoken",
              root / "solo-a"):
        assert not p.exists(), p
    assert [j["metadata"]["owner"] for j in env.scheduler.jobs] == [B]
    assert env.reaper.ids == ["agent-110-chat-main", "agent-22-chat-main", "agent-meet-77"]
    assert sorted(env.redis.keys()) == sorted([
        "agent:sessions:22", "agent:session:22:main", "unit:agent-110-chat-main:out",
        "unit:agent-22-chat-main:out", "proc:meeting:5"])

    # user B untouched
    assert (root / B / "kg" / "note.md").read_text() == "22 secret\n"
    assert (root / ".attached" / B / "slot-1" / "f.md").exists()
    assert (root / ".system" / B / "summary.md").exists() and (root / ".secrets" / f"{B}.ghtoken").exists()
    # the shared workspace B owns that A belonged to: content kept, A gone, B still owner, A's invite dead
    assert (root / "team-b" / "data.md").read_text() == "team-b content\n"
    assert env.members("team-b") == {B: "owner"}
    assert [i["revoked"] for i in m.list_invites(root, "team-b")] == [True]
    # shared workspaces A owned: kept for their members, ownership handed to the longest-standing one
    assert env.members("proj-a") == {B: "owner"}
    assert (root / "proj-a" / "data.md").exists()
    assert env.members("proj-a2") == {"33": "owner", B: "viewer"}
    assert env.members("joint") == {B: "owner"}
    assert env.index.list(A) == []


def test_second_call_returns_zero_counts(env):
    assert env.erase().status_code == 200
    again = env.erase()
    assert again.status_code == 200
    assert set(again.json()["erased"].values()) == {0}
    assert env.members("proj-a") == {B: "owner"}


def test_mid_way_failure_is_5xx_and_retry_completes(env):
    env.reaper.fail_on = "agent-11-scheduled-abc"
    r = env.erase()
    assert r.status_code == 500
    assert r.json()["stage"] == "units" and "error" in r.json()
    assert "erased" not in r.json()
    assert (env.root / A).exists() and env.redis.exists("agent:sessions:11")  # nothing later was claimed
    env.reaper.fail_on = None
    assert env.erase().status_code == 200
    assert not (env.root / A).exists() and not env.redis.exists("agent:sessions:11")
    assert [j["metadata"]["owner"] for j in env.scheduler.jobs] == [B]
    assert env.erase().json()["erased"]["units"] == 0


def test_failure_between_ownership_transfer_and_leave_resumes(env, monkeypatch):
    real = m.remove_member
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("disk full")
        return real(*a, **k)

    monkeypatch.setattr(m, "remove_member", flaky)
    r = env.erase()
    assert r.status_code == 500 and r.json()["stage"] == "shared_workspaces"
    assert env.erase().status_code == 200
    for ws in ("team-b", "proj-a", "proj-a2", "joint"):
        assert A not in env.members(ws)
    assert "owner" in env.members("proj-a").values()


@pytest.mark.parametrize("headers, status", [
    ({}, 403), ({"X-Internal-Secret": "wrong"}, 403), ({"X-Internal-Secret": ""}, 403),
    # a request that came through the gateway (identity headers injected) is refused even with the secret
    ({**HDR, "X-User-Id": "11"}, 403), ({**HDR, "X-Gateway-Verified": "1"}, 403),
])
def test_auth_fails_closed_and_touches_nothing(env, headers, status):
    assert env.erase(headers=headers).status_code == status
    assert (env.root / A / "kg" / "note.md").exists() and len(env.scheduler.jobs) == 3


def test_unset_secret_is_503_even_with_a_header(env):
    c = env.make_client(secret="")
    for hdr in ({}, {"X-Internal-Secret": ""}, {"X-Internal-Secret": "anything"}):
        assert c.post(f"/internal/accounts/{A}/erase", headers=hdr).status_code == 503
    assert (env.root / A).exists()


@pytest.mark.parametrize("subject", ["..", ".attached", "a-b", "x*"])
def test_unsafe_subjects_are_rejected(env, subject):
    r = env.client.post(f"/internal/accounts/{subject}/erase", headers=HDR)
    assert r.status_code in (400, 404)
    assert (env.root / ".attached" / B).exists() and (env.root / ".system" / B).exists()


def test_not_under_the_gateway_forwarded_prefix(env):
    # the gateway maps /agent/<path> to /api/<path>; the erase route lives outside /api
    assert env.client.post(f"/api/internal/accounts/{A}/erase", headers=HDR).status_code == 404
    assert (env.root / A).exists()
