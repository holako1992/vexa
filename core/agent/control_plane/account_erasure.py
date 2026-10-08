"""account_erasure.py — erase ONE account's footprint in the agent domain.

The identity service orchestrates account deletion: it locks the account (every token revoked), asks each
domain to erase what it holds for that subject, then removes the user row. This module is the agent
domain's part, reached through agent-api's internal ``POST /internal/accounts/{subject}/erase``. The
``subject`` is the user id as the gateway injects it (``X-User-Id`` = the stringified ``users.id``).

What the agent domain holds for a subject, and what happens to it:

  * routine jobs      — schedule.v1 jobs whose ``metadata.owner`` is the subject are cancelled, so nothing
                        fires a dispatch for the account after this point.
  * warm units        — runtime workloads ``agent-<subject>-*`` are destroyed (chat threads, schedules, events).
  * shared workspaces — a top-level workspace whose ``policy/members.json`` lists the subject:
        - the subject is the only member            → the workspace is deleted;
        - other members remain                      → the subject leaves; when the subject was the sole
          owner, the longest-standing remaining member (contributors first) is promoted so the workspace
          stays governable. The workspace content is the remaining members' data and is kept intact.
          Invites the subject minted are revoked so no link outlives the account.
  * private storage   — the baseline tree ``<root>/<subject>``, parked slots ``.attached/<subject>``, the
                        private system tier ``.system/<subject>`` (chat sessions, notes, summaries) and the
                        stored git token ``.secrets/<subject>.ghtoken``.
  * redis             — the chat-session index (``agent:session[s]:<subject>…``) and the unit streams
                        (``unit:agent-<subject>-*``: ``:in`` ``:out`` ``:turnhead``).

Every stage is discovered by scanning, never by remembered state, and each is idempotent: a retry after a
crash resumes where the last pass stopped, and an erased account answers with zero counts. Stages run so
that nothing can re-create what an earlier stage removed — jobs and units first (no new work), shared
membership next, then the private trees and the redis keys the units were writing.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Optional, Protocol

from control_plane import workspace_membership as membership
from control_plane.workspace_attach import STORE_DIRNAME as ATTACHED_DIRNAME
from control_plane.system_mounts import SYSTEM_STORE_DIRNAME
from control_plane.git_credentials import _SECRETS_DIRNAME

log = logging.getLogger("agent_api.account_erasure")

# A subject is a stringified numeric user id. The pattern is deliberately narrower than the path-safe
# alphabet the stores accept: no ``-`` (the unit id ``agent-<subject>-…`` must stay unambiguous), no glob
# characters (the redis scan pattern embeds the subject), and never a dot-leading name (reserved stores).
_SUBJECT_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$")


class ErasureError(RuntimeError):
    """A stage failed. ``stage`` names it so the caller reports exactly what was not finished."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


class UnitReaper(Protocol):
    """Lists and destroys runtime workloads — the control-plane→kernel edge for the units of one subject."""

    def list_ids(self) -> list[str]: ...

    def destroy(self, workload_id: str) -> None: ...


class HttpUnitReaper:
    """``UnitReaper`` over runtime.v1's ``/workloads`` surface (stdlib urllib, like the other kernel edges)."""

    def __init__(self, base_url: str, *, timeout: float = 10.0) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    def list_ids(self) -> list[str]:
        req = urllib.request.Request(f"{self._base}/workloads", method="GET")
        with urllib.request.urlopen(req, timeout=self._timeout) as r:  # noqa: S310 — internal service URL
            rows = json.loads(r.read())
        return [str(s["workloadId"]) for s in rows if isinstance(s, dict) and s.get("workloadId")]

    def destroy(self, workload_id: str) -> None:
        req = urllib.request.Request(f"{self._base}/workloads/{workload_id}", method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout):  # noqa: S310
                pass
        except urllib.error.HTTPError as e:
            if e.code != 404:  # already gone is success
                raise


def valid_subject(subject: str) -> bool:
    return bool(_SUBJECT_RE.match(subject or "")) and set(subject) != {"."}


def _rmtree(path: Path) -> bool:
    """Remove a file/dir/symlink if present; True iff something was removed. Read-only git objects are
    made writable and retried; any failure that survives raises (the stage reports it, a retry resumes)."""
    if path.is_symlink() or path.is_file():
        path.unlink()
        return True
    if not path.exists():
        return False

    def _chmod_retry(func, p, exc_info):  # noqa: ANN001
        os.chmod(p, stat.S_IRWXU)
        func(p)

    shutil.rmtree(path, onerror=_chmod_retry)
    return True


def _cancel_routine_jobs(subject: str, scheduler) -> int:
    if scheduler is None:
        return 0
    n = 0
    for job in scheduler.list_jobs(limit=1000):
        meta = job.get("metadata") or {}
        body = ((job.get("request") or {}).get("body") or {})
        owner = meta.get("owner") or ((body.get("identity") or {}).get("subject"))
        if owner != subject or not job.get("job_id"):
            continue
        if scheduler.cancel_job(job["job_id"]) is not None:
            n += 1
    return n


def _destroy_units(subject: str, reaper: Optional[UnitReaper]) -> int:
    if reaper is None:
        return 0
    prefix = f"agent-{subject}-"
    n = 0
    for wid in reaper.list_ids():
        if wid.startswith(prefix):
            reaper.destroy(wid)
            n += 1
    return n


def _shared_workspace_ids(root: Path, subject: str) -> list[str]:
    """Top-level workspaces whose authoritative member list names the subject (never the subject's own
    baseline, the dot-namespaced stores, or the reserved system slugs)."""
    ids: list[str] = []
    if not root.is_dir():
        return ids
    for child in sorted(root.iterdir()):
        name = child.name
        if (name.startswith(".") or name == subject or name in membership.RESERVED_SLUGS
                or not child.is_dir() or child.is_symlink()):
            continue
        if membership.is_member(root, name, subject) is not None:
            ids.append(name)
    return ids


def _leave_shared(root: Path, ws_id: str, subject: str, index) -> dict:
    """The subject leaves one shared workspace. Returns ``{"deleted"|"left", "promoted", "invites"}``."""
    members = membership.read_members(root, ws_id)
    others = [m for m in members if m.get("subject") != subject]
    if not others:
        membership._index_remove(index, subject, ws_id)  # index first: a crash leaves the tree for the retry
        _rmtree(membership._ws_dir(root, ws_id))
        return {"outcome": "deleted", "invites": 0}
    me = next(m for m in members if m.get("subject") == subject)
    promoted = False
    if me.get("role") == "owner" and not any(m.get("role") == "owner" for m in others):
        rank = {"contributor": 0, "viewer": 1}
        successor = sorted(
            others, key=lambda m: (rank.get(m.get("role"), 2), str(m.get("added_at") or ""), str(m.get("subject"))),
        )[0]
        membership.set_role(root, ws_id, successor["subject"], "owner", changed_by=subject, index=index,
                            commit_fn=membership.policy_commit)
        promoted = True
    invites = 0
    for inv in membership._read_json_list(membership._ws_dir(root, ws_id), membership.INVITES_FILE):
        if inv.get("created_by") == subject and not inv.get("revoked"):
            membership.revoke_invite(root, ws_id, inv["id"], commit_fn=membership.policy_commit)
            invites += 1
    membership.remove_member(root, ws_id, subject, index=index, commit_fn=membership.policy_commit)
    return {"outcome": "left", "promoted": promoted, "invites": invites}


def _delete_redis_keys(redis_client, patterns: list[str]) -> int:
    n = 0
    for pattern in patterns:
        keys = list(redis_client.scan_iter(match=pattern, count=500))
        if keys:
            n += int(redis_client.delete(*keys))
    return n


def erase_account(
    subject: str,
    *,
    root: str | Path,
    scheduler=None,
    reaper: Optional[UnitReaper] = None,
    redis_client=None,
    membership_index=None,
    purge_sessions: Optional[Callable[[str], int]] = None,
) -> dict[str, int]:
    """Erase everything the agent domain holds for ``subject``; return ``{what: count}``.
    Raises ``ErasureError(stage, …)`` on the first stage that fails — completed stages stay completed and a
    retry resumes (every stage is idempotent and discovers its own work)."""
    if not valid_subject(subject):
        raise ErasureError("validate", "invalid subject")
    rootp = Path(root)
    index = membership_index if membership_index is not None else membership.InMemoryMembershipIndex()
    erased: dict[str, int] = {}

    def stage(name: str, fn):
        try:
            return fn()
        except ErasureError:
            raise
        except Exception as exc:  # noqa: BLE001 — typed to the stage; the caller reports it, a retry resumes
            log.exception("account erasure stage failed stage=%s subject=%s", name, subject)
            raise ErasureError(name, f"{type(exc).__name__}: {exc}") from exc

    erased["routine_jobs"] = stage("routines", lambda: _cancel_routine_jobs(subject, scheduler))
    erased["units"] = stage("units", lambda: _destroy_units(subject, reaper))

    def shared() -> dict[str, int]:
        out = {"shared_workspaces_deleted": 0, "shared_memberships_removed": 0,
               "shared_ownership_transferred": 0, "invites_revoked": 0}
        for ws_id in _shared_workspace_ids(rootp, subject):
            r = _leave_shared(rootp, ws_id, subject, index)
            out["invites_revoked"] += r["invites"]
            if r["outcome"] == "deleted":
                out["shared_workspaces_deleted"] += 1
            else:
                out["shared_memberships_removed"] += 1
                out["shared_ownership_transferred"] += 1 if r["promoted"] else 0
        return out

    erased.update(stage("shared_workspaces", shared))

    def private() -> dict[str, int]:
        baseline = rootp / subject
        slots = rootp / ATTACHED_DIRNAME / subject
        n_slots = sum(1 for p in slots.iterdir() if p.is_dir()) if slots.is_dir() else 0
        out = {
            "private_workspaces": (1 if baseline.exists() or baseline.is_symlink() else 0) + n_slots,
            "system_workspaces": 1 if (rootp / SYSTEM_STORE_DIRNAME / subject).exists() else 0,
            "credentials": 1 if (rootp / _SECRETS_DIRNAME / f"{subject}.ghtoken").exists() else 0,
        }
        for path in (baseline, slots, rootp / SYSTEM_STORE_DIRNAME / subject,
                     rootp / _SECRETS_DIRNAME / f"{subject}.ghtoken"):
            _rmtree(path)
        return out

    erased.update(stage("workspaces", private))

    def sessions() -> int:
        n = purge_sessions(subject) if purge_sessions is not None else 0
        if redis_client is not None:
            n += _delete_redis_keys(redis_client, [
                f"agent:sessions:{subject}", f"agent:session:{subject}:*", f"unit:agent-{subject}-*"])
        return n

    erased["redis_keys"] = stage("redis", sessions)
    return erased
