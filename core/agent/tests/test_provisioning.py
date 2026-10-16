"""A subject's workspace tiers exist BEFORE its first worker is asked for.

The runtime mounts each workspace as a volume subpath and docker refuses to start a container whose
subpath is missing, so a subject whose account was made outside the terminal (the dashboard's Google
sign-in, a flows-triggered summary) used to fail every turn with
``cannot access path …/agent-workspaces/_data/<subject>``. The Dispatcher now provisions first.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from control_plane import provisioning
from control_plane.dispatch import Dispatcher
from shared import units
from shared.config import load_settings

SEEDS = str(Path(__file__).resolve().parents[1] / "workspace-seeds")


class _RecordingRuntime:
    """Records, at spawn time, whether the subject's tiers were already on disk."""

    def __init__(self, root: Path, subject: str):
        self._root, self._subject = root, subject
        self.seen: list[tuple[str, bool, bool]] = []

    def spawn(self, workload_id, profile, env):
        ws = self._root / self._subject / ".git"
        system = provisioning.system_mounts.system_store_path(str(self._root), self._subject) / ".git"
        self.seen.append((workload_id, ws.exists(), system.exists()))
        return workload_id

    def await_done(self, workload_id, timeout_sec=0.0):
        return "completed"


class _Identity:
    def mint(self, subject, launcher, workspaces, tools):
        return "tok"


def _scheduled(subject: str):
    return units.make_dispatch(subject=subject, trigger="scheduled",
                               start=units.entrypoint(inline="summarise"), context={"kind": "none"})


def test_provision_creates_both_tiers_once(tmp_path):
    first = provisioning.provision_subject(str(tmp_path), "3", default_template="default", seeds_root=SEEDS)
    assert (tmp_path / "3" / ".git").exists()
    assert (provisioning.system_mounts.system_store_path(str(tmp_path), "3") / ".git").exists()
    assert (first.already_initialized, first.system_seeded) == (False, True)

    again = provisioning.provision_subject(str(tmp_path), "3", default_template="default", seeds_root=SEEDS)
    assert (again.already_initialized, again.system_seeded) == (True, False)


def test_an_invalid_subject_is_refused_before_touching_disk(tmp_path):
    with pytest.raises(ValueError):
        provisioning.provision_subject(str(tmp_path), "../escape", default_template="default", seeds_root=SEEDS)
    assert list(tmp_path.iterdir()) == []


def test_a_first_turn_finds_its_workspace_already_there(tmp_path):
    runtime = _RecordingRuntime(tmp_path, "3")
    settings = load_settings(workspaces_dir=str(tmp_path), workspace_seeds_dir=SEEDS, default_template="default")
    Dispatcher(settings, runtime, _Identity(), provision=True).dispatch(_scheduled("3"))
    assert runtime.seen and runtime.seen[0][1:] == (True, True)


def test_a_dispatcher_without_provisioning_seeds_no_baseline(tmp_path):
    """The control: the mount builder already ensures `_system` on its own, and only the baseline was
    left to the worker — the asymmetry this file is about."""
    runtime = _RecordingRuntime(tmp_path, "3")
    settings = load_settings(workspaces_dir=str(tmp_path), workspace_seeds_dir=SEEDS, default_template="default")
    Dispatcher(settings, runtime, _Identity()).dispatch(_scheduled("3"))
    assert runtime.seen[0][1] is False
    assert not (tmp_path / "3").exists()
