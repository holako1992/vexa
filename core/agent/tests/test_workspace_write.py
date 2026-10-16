"""`PUT /api/workspace/file`: one file into the caller's OWN workspace, committed.

flows' post-meeting steps write a meeting's page through this door (`flows_steps.agent.workspace_write`);
without it every `drop_to_attendees` answered 405 and the meeting summary was never recorded.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from control_plane import provisioning
from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from control_plane.workspace_reader import WorkspaceReader
from shared.config import load_settings

SEEDS = str(Path(__file__).resolve().parents[1] / "workspace-seeds")


class _Runtime:
    def spawn(self, workload_id, profile, env):
        return workload_id

    def await_done(self, workload_id, timeout_sec=0.0):
        return "completed"


class _Identity:
    def mint(self, subject, launcher, workspaces, tools):
        return "tok"


@pytest.fixture()
def client(tmp_path):
    provisioning.provision_subject(str(tmp_path), "7", default_template="default", seeds_root=SEEDS)
    provisioning.provision_subject(str(tmp_path), "8", default_template="default", seeds_root=SEEDS)
    settings = load_settings(workspaces_dir=str(tmp_path))
    app = create_app(Dispatcher(settings, _Runtime(), _Identity()), reader=WorkspaceReader(str(tmp_path)))
    return TestClient(app), tmp_path


def _put(c, body, uid="7"):
    return c.put("/api/workspace/file", json=body, headers={"X-User-Id": uid})


def test_a_write_lands_in_the_callers_workspace_and_is_committed(client):
    c, root = client
    r = _put(c, {"path": "kg/entities/meeting/2026-10-16-ai.md", "content": "# AI\n"})
    assert r.status_code == 200, r.text
    assert (root / "7" / "kg/entities/meeting/2026-10-16-ai.md").read_text() == "# AI\n"
    log = subprocess.run(["git", "-C", str(root / "7"), "log", "-1", "--format=%an %s"],
                         capture_output=True, text=True).stdout.strip()
    assert log == "vexa-terminal write kg/entities/meeting/2026-10-16-ai.md"
    got = c.get("/api/workspace/file", params={"path": "kg/entities/meeting/2026-10-16-ai.md"},
                headers={"X-User-Id": "7"})
    assert got.json()["content"] == "# AI\n"


@pytest.mark.parametrize("path,code", [
    ("../8/README.md", 400),
    ("/etc/passwd", 400),
    (".git/config", 400),
    ("kg/templates/person.md", 403),
    ("", 400),
])
def test_a_path_outside_the_workspace_or_into_its_internals_is_refused(client, path, code):
    c, root = client
    before = (root / "8" / "README.md").read_text()
    assert _put(c, {"path": path, "content": "x"}).status_code == code
    assert (root / "8" / "README.md").read_text() == before


def test_another_subjects_workspace_is_never_a_target(client):
    c, root = client
    assert _put(c, {"path": "note.md", "content": "x", "slug": "8"}).status_code == 403
    assert not (root / "8" / "note.md").exists()


def test_content_must_be_text(client):
    c, _root = client
    assert _put(c, {"path": "note.md", "content": 3}).status_code == 400
