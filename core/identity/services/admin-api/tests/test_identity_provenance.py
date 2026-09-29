"""Sign-in provenance and the verified-identity Free allowance: the pure half, no docker.

`identity_provenance.merge_identity` (set / upgrade / never downgrade), the request models'
validation refusals, and `resolve_plan`'s identity gate. The endpoint wiring (create, patch,
`/user/entitlements`, `/internal/users/{id}/bot-context`) is `test_identity_provenance_endpoint.py`.
"""
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from admin_api.app.billing.entitlements import IDENTITY_UNVERIFIED, resolve_plan
from admin_api.app.main import UserAdminPatch, UserCreate
from admin_api.identity_provenance import is_explicitly_unverified, merge_identity

UTC = timezone.utc
NOW = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)
UNVERIFIED = {"identity": {"provider": "email", "email_verified": False}}


# -- merge_identity -------------------------------------------------------------------------------

def test_a_verified_claim_records_provider_flag_and_timestamp():
    out = merge_identity({}, "google", True, NOW)
    assert out["identity"] == {
        "provider": "google", "email_verified": True, "verified_at": "2026-09-15T12:00:00+00:00",
    }


def test_an_unverified_claim_records_no_timestamp():
    assert merge_identity({}, "email", False, NOW)["identity"] == {
        "provider": "email", "email_verified": False,
    }


def test_a_verified_claim_upgrades_an_unverified_record():
    out = merge_identity(UNVERIFIED, "google", True, NOW)
    assert out["identity"]["email_verified"] is True
    assert out["identity"]["provider"] == "google"


def test_a_later_unverified_claim_never_downgrades_a_verified_record():
    verified = merge_identity({}, "google", True, NOW)
    out = merge_identity(verified, "email", False, NOW)
    assert out["identity"] == verified["identity"]


def test_a_second_verified_claim_keeps_the_first_record():
    first = merge_identity({}, "google", True, NOW)
    later = datetime(2027, 1, 1, tzinfo=UTC)
    assert merge_identity(first, "microsoft", True, later)["identity"] == first["identity"]


def test_merge_keeps_unrelated_data_and_does_not_mutate_the_input():
    data = {"subscription_tier": "pro"}
    out = merge_identity(data, "google", True, NOW)
    assert out["subscription_tier"] == "pro"
    assert "identity" not in data


def test_only_a_stored_false_is_explicitly_unverified():
    assert is_explicitly_unverified(UNVERIFIED) is True
    assert is_explicitly_unverified({}) is False
    assert is_explicitly_unverified({"identity": {"provider": "google", "email_verified": True}}) is False
    assert is_explicitly_unverified({"identity": {"provider": "google"}}) is False
    assert is_explicitly_unverified({"identity": "garbage"}) is False


# -- request validation ---------------------------------------------------------------------------

def test_create_accepts_a_paired_claim_and_a_claimless_body():
    assert UserCreate(email="a@b.co", identity_provider="google", email_verified=True).email_verified is True
    assert UserCreate(email="a@b.co").identity_provider is None


@pytest.mark.parametrize("model", [UserCreate, UserAdminPatch])
def test_an_unknown_provider_is_refused(model):
    extra = {"email": "a@b.co"} if model is UserCreate else {}
    with pytest.raises(ValidationError):
        model(**extra, identity_provider="github", email_verified=True)


@pytest.mark.parametrize("model", [UserCreate, UserAdminPatch])
@pytest.mark.parametrize("bad", ["true", "yes", 1, 0, "false"])
def test_email_verified_must_be_a_real_boolean(model, bad):
    extra = {"email": "a@b.co"} if model is UserCreate else {}
    with pytest.raises(ValidationError):
        model(**extra, identity_provider="google", email_verified=bad)


@pytest.mark.parametrize("model", [UserCreate, UserAdminPatch])
def test_the_two_fields_travel_together(model):
    extra = {"email": "a@b.co"} if model is UserCreate else {}
    with pytest.raises(ValidationError):
        model(**extra, identity_provider="google")
    with pytest.raises(ValidationError):
        model(**extra, email_verified=True)


def test_a_provenance_only_patch_satisfies_require_change():
    UserAdminPatch(identity_provider="google", email_verified=True)  # must not raise


# -- the entitlement gate -------------------------------------------------------------------------

def test_explicitly_unverified_free_gets_zero_meetings_and_the_reason():
    plan = resolve_plan(dict(UNVERIFIED), NOW)
    assert plan.plan_id == "free"
    assert plan.limits.meetings_per_month == 0
    assert plan.reason == IDENTITY_UNVERIFIED == "identity_unverified"


def test_no_identity_record_is_unchanged():
    plan = resolve_plan({}, NOW)
    assert plan.limits.meetings_per_month == 1
    assert plan.reason is None


def test_a_verified_record_keeps_the_free_allowance():
    plan = resolve_plan({"identity": {"provider": "google", "email_verified": True}}, NOW)
    assert plan.limits.meetings_per_month == 1
    assert plan.reason is None


def test_a_paid_plan_wins_over_the_unverified_record():
    data = {**UNVERIFIED, "subscription_status": "active", "subscription_tier": "pro"}
    plan = resolve_plan(data, NOW)
    assert plan.plan_id == "pro"
    assert plan.limits.meetings_per_month is None
    assert plan.reason is None


def test_a_lapsed_paid_plan_falling_back_to_free_is_gated():
    data = {**UNVERIFIED, "subscription_status": "canceled", "subscription_tier": "pro",
            "subscription_current_period_end": int(datetime(2026, 8, 1, tzinfo=UTC).timestamp())}
    plan = resolve_plan(data, NOW)
    assert plan.plan_id == "free"
    assert plan.limits.meetings_per_month == 0


def test_plan_override_wins_over_the_gate():
    plan = resolve_plan({**UNVERIFIED, "plan_override": "free"}, NOW)
    assert plan.limits.meetings_per_month == 1
    assert plan.reason is None
    assert resolve_plan({**UNVERIFIED, "plan_override": "pro"}, NOW).plan_id == "pro"


def test_quota_bonus_adds_to_the_gated_zero():
    period_start = int(datetime(2026, 9, 1, tzinfo=UTC).timestamp())
    plan = resolve_plan({**UNVERIFIED, "quota_bonus": 2, "quota_bonus_period_start": period_start}, NOW)
    assert plan.limits.meetings_per_month == 2
    assert plan.quota_bonus_applied == 2
