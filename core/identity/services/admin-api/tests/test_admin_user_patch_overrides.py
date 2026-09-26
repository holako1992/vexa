"""DB-77 — `PATCH /admin/users/{id}`'s `plan_override`/`quota_bonus` request schema
(`admin_api.app.main.UserAdminPatch`).

Pure pydantic validation, no database, no FastAPI TestClient: importing `admin_api.app.main`
builds its classes at module scope with no I/O, so this suite runs with no docker and no
testcontainers. The endpoint's DB-backed write path (stamping `quota_bonus_period_start`,
merging into `users.data`, admin auth) is covered by `test_stack_admin_api.py`'s
testcontainers-gated suite — those cases skip on a host with no docker; see this task's report
for which ones.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from admin_api.app.main import UserAdminPatch


def test_plan_override_accepts_a_known_catalog_plan():
    patch = UserAdminPatch(plan_override="team")
    assert patch.plan_override == "team"


def test_plan_override_unknown_plan_id_is_422_shaped_validation_error():
    with pytest.raises(ValidationError) as excinfo:
        UserAdminPatch(plan_override="enterprise")
    assert "unknown plan id" in str(excinfo.value)


def test_plan_override_none_is_a_valid_explicit_clear():
    patch = UserAdminPatch(plan_override=None)
    # The field WAS supplied (as null) — distinguishable from being left out entirely, which is
    # exactly how the endpoint tells "clear the override" apart from "leave it alone".
    assert "plan_override" in patch.model_fields_set
    assert patch.plan_override is None


def test_quota_bonus_accepts_zero_and_positive_ints():
    assert UserAdminPatch(quota_bonus=0).quota_bonus == 0
    assert UserAdminPatch(quota_bonus=5).quota_bonus == 5


def test_quota_bonus_negative_is_a_validation_error():
    with pytest.raises(ValidationError) as excinfo:
        UserAdminPatch(quota_bonus=-1)
    assert "greater_than_equal" in str(excinfo.value) or "greater than or equal" in str(excinfo.value)


def test_quota_bonus_none_is_a_valid_explicit_clear():
    patch = UserAdminPatch(quota_bonus=None)
    assert "quota_bonus" in patch.model_fields_set
    assert patch.quota_bonus is None


def test_plan_override_alone_satisfies_require_change():
    """Before DB-77, a patch with no `max_concurrent_bots` and no `data` was rejected as a no-op.
    `plan_override`/`quota_bonus` are real changes too — they must not be rejected the same way."""
    UserAdminPatch(plan_override="pro")  # must not raise
    UserAdminPatch(quota_bonus=1)  # must not raise


def test_empty_patch_is_still_rejected_as_a_no_op():
    with pytest.raises(ValidationError):
        UserAdminPatch()


def test_extra_fields_still_forbidden():
    with pytest.raises(ValidationError):
        UserAdminPatch(plan_override="pro", made_up_field=True)
