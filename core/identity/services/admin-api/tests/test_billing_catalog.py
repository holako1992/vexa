"""DB-72 — `billing.catalog.effective_concurrent_cap`: combining the resolved plan's
`concurrent_bots` with the pre-billing `users.max_concurrent_bots` column into the ONE number
`/internal/validate` and `/internal/users/{id}/bot-context` both return as `max_concurrent`.

No docker: this is a pure function over two ints (see its docstring in `billing/catalog.py` for
the combination rule and the stated product change for untouched Free users).
"""
from __future__ import annotations

from admin_api.app.billing.catalog import (
    LEGACY_MAX_CONCURRENT_BOTS_DEFAULT,
    effective_concurrent_cap,
)


def test_untouched_default_lets_the_plan_decide_alone():
    """The column still reads the legacy default (3) — nobody has ever PATCHed it — so a Free
    user's plan (1) applies UNCLAMPED, not raised to 3. This is DB-72's stated product change."""
    assert effective_concurrent_cap(1, LEGACY_MAX_CONCURRENT_BOTS_DEFAULT) == 1


def test_untouched_default_does_not_clamp_a_paid_plan_down():
    """A Pro (2) or Team (5) user nobody has ever touched with PATCH /admin/users/{id} gets their
    plan's real number, not clamped down to the legacy default of 3."""
    assert effective_concurrent_cap(2, LEGACY_MAX_CONCURRENT_BOTS_DEFAULT) == 2
    assert effective_concurrent_cap(5, LEGACY_MAX_CONCURRENT_BOTS_DEFAULT) == 5


def test_none_stored_value_behaves_like_the_untouched_default():
    assert effective_concurrent_cap(1, None) == 1
    assert effective_concurrent_cap(5, None) == 5


def test_explicit_lower_override_narrows_below_the_plan():
    """An operator who has explicitly set the column to something OTHER than the legacy default is
    a deliberate ceiling — it always narrows, never widens past the plan."""
    assert effective_concurrent_cap(5, 1) == 1
    assert effective_concurrent_cap(2, 1) == 1


def test_explicit_higher_value_still_never_exceeds_the_plan():
    """Until DB-77 ships a real override/bonus field, this column cannot raise a user ABOVE their
    plan — that would be building the override this task is told not to build."""
    assert effective_concurrent_cap(1, 10) == 1
    assert effective_concurrent_cap(2, 10) == 2


def test_zero_stored_value_is_a_real_explicit_cap_not_the_default():
    """0 != LEGACY_MAX_CONCURRENT_BOTS_DEFAULT — an operator who explicitly zeroed a user out (a
    suspension) must not be silently restored to the plan's higher number."""
    assert effective_concurrent_cap(5, 0) == 0
