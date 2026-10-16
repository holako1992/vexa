"""Provision a subject's workspace tiers — the Personal baseline (``<root>/<subject>``, seeded from the
validated workspace template) and the private ``_system`` tier — CREATE-IF-ABSENT and idempotent.

Two callers, one primitive: ``POST /api/workspace/init`` (the eager "on account creation" control) and
the Dispatcher, before every spawn. The second is load-bearing: the runtime mounts each workspace as a
VOLUME SUBPATH (strict tenant isolation), and docker refuses to start a container whose subpath does not
exist yet — so a subject's first turn cannot be the thing that creates its own workspace. Whatever starts
a subject's first turn (the dashboard's chat, a flows post-meeting summary, a schedule) gets the same
tiers, in place, before the worker is asked for.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from control_plane import system_mounts
from control_plane.workspace_reader import WorkspaceReader
from shared.seeding import resolve_seed_dir, seed_workspace, validate_seed


class InvalidSeed(RuntimeError):
    """The configured workspace template does not pass `validate_seed` — nothing is materialized."""


@dataclass(frozen=True)
class Provisioned:
    workspace: Path
    already_initialized: bool
    system_seeded: bool


def provision_subject(root: str, subject: str, *, default_template: Optional[str],
                      seeds_root: Optional[str]) -> Provisioned:
    """Ensure ``subject``'s baseline and ``_system`` tiers exist; existing tiers (``.git`` present) are
    left untouched. Raises ``ValueError`` for a subject that is not a valid workspace name and
    ``InvalidSeed`` for a template that fails validation."""
    ws = WorkspaceReader(root).workspace_dir(subject)
    seed_dir = resolve_seed_dir(default_template, seeds_root=seeds_root)
    problems = validate_seed(seed_dir)
    if problems:
        raise InvalidSeed("invalid workspace seed: " + "; ".join(problems))
    existed = (ws / ".git").exists()
    seed_workspace(ws, seed_dir)
    system_existed = (system_mounts.system_store_path(root, subject) / ".git").exists()
    system_mounts.ensure_system_workspace(str(root), subject)
    return Provisioned(workspace=ws, already_initialized=existed, system_seeded=not system_existed)
