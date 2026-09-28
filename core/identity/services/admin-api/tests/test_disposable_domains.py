"""This trial-abuse floor, pure unit coverage — no DB, no docker (`disposable_domains.py` reads
only its vendored file and the process env). The full `POST /admin/users` → 422 path is in
`test_signup_disposable_domain.py` (docker-gated, mirrors `test_email_case_folding.py`'s shape).
"""
import pytest

from admin_api import disposable_domains as dd


def test_a_known_disposable_domain_matches():
    assert dd.is_disposable_domain("someone@mailinator.com") is True


def test_matching_is_case_insensitive():
    assert dd.is_disposable_domain("Someone@MAILINATOR.com") is True


def test_a_subdomain_of_a_listed_domain_also_matches():
    assert dd.is_disposable_domain("someone@sub.mailinator.com") is True


def test_a_domain_that_merely_contains_a_listed_one_as_a_substring_does_not_match():
    """Dot-boundary walk, never a substring test — `mailinatorx.com` is a distinct registrable
    domain (not itself vendored) and must not be refused just because it ends in a listed
    domain's letters with no dot before them."""
    assert "mailinatorx.com" not in dd._vendored_domains()  # guards the fixture itself
    assert dd.is_disposable_domain("someone@mailinatorx.com") is False


def test_an_ordinary_domain_does_not_match():
    assert dd.is_disposable_domain("someone@acme.test") is False


def test_no_at_sign_is_not_disposable():
    assert dd.is_disposable_domain("not-an-email") is False


def test_empty_string_is_not_disposable():
    assert dd.is_disposable_domain("") is False


def test_the_vendored_list_is_non_trivially_sized():
    """A sanity floor on the vendored file itself — catches a truncated or empty re-vendor."""
    assert len(dd._vendored_domains()) > 1000


class TestSignupBlockDisabled:
    def test_default_is_enabled(self, monkeypatch):
        monkeypatch.delenv("SIGNUP_ALLOW_DISPOSABLE", raising=False)
        assert dd.signup_block_disabled() is False

    def test_true_disables_it(self, monkeypatch):
        monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", "true")
        assert dd.signup_block_disabled() is True

    @pytest.mark.parametrize("value", ["True", "TRUE", " true "])
    def test_case_and_whitespace_tolerant(self, monkeypatch, value):
        monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", value)
        assert dd.signup_block_disabled() is True

    @pytest.mark.parametrize("value", ["", "yes", "1", "false", "TRU"])
    def test_anything_unrecognized_or_falsy_stays_enabled(self, monkeypatch, value):
        """Fail-safe: a typo in the override must never silently open the door (same posture as
        `main.py`'s `_as_flag`)."""
        monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", value)
        assert dd.signup_block_disabled() is False


class TestExtraDomains:
    def test_unset_adds_nothing(self, monkeypatch):
        monkeypatch.delenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", raising=False)
        assert dd.is_disposable_domain("someone@operator-flagged.test") is False

    def test_an_operator_addition_is_blocked(self, monkeypatch):
        monkeypatch.setenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", "operator-flagged.test")
        assert dd.is_disposable_domain("someone@operator-flagged.test") is True

    def test_a_subdomain_of_an_operator_addition_is_also_blocked(self, monkeypatch):
        monkeypatch.setenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", "operator-flagged.test")
        assert dd.is_disposable_domain("someone@mail.operator-flagged.test") is True

    def test_multiple_comma_separated_entries(self, monkeypatch):
        monkeypatch.setenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", "one.test, two.test ,three.test")
        assert dd.is_disposable_domain("a@one.test") is True
        assert dd.is_disposable_domain("a@two.test") is True
        assert dd.is_disposable_domain("a@three.test") is True

    def test_the_vendored_list_is_unaffected_by_an_empty_extra_entry(self, monkeypatch):
        monkeypatch.setenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", ", ,")
        assert dd.is_disposable_domain("someone@acme.test") is False
