"""First run — who is welcomed, and that the welcome's state is the account's, not a browser's.

Offline: the pure decisions in `first_run.py`. No docker. The routes over a real Postgres are in
`test_first_run_endpoint.py`.

Each test is the failure it exists to prevent:
  * an account that PREDATES the sign-up stamp, or is older than the window, is welcomed anyway —
    every established user meets a "welcome" the day the dashboard ships it;
  * "zero meetings" is taken as "new" — a person who deleted their meetings is welcomed again
    (the meetings count is not in identity at all, so nothing here can be keyed on it);
  * an ended welcome comes back — a second tab, or a replayed request, re-opens a thing the person
    closed.
"""
import pytest

from admin_api.app import first_run as fr

NOW = 1_800_000_000.0
DAY = 24 * 3600.0


def new(age=60.0, **extra):
    return {fr.CREATED_KEY: NOW - age, **extra}


def test_a_fresh_account_is_welcomed_at_the_first_step():
    assert fr.read(new(), NOW) == {"state": "active", "step": "name"}


def test_the_recorded_step_is_where_a_refresh_resumes():
    data = fr.apply(new(), {"step": "calendar"}, NOW)
    assert fr.read(data, NOW) == {"state": "active", "step": "calendar"}


@pytest.mark.parametrize("data", [
    {},                                                         # predates the stamp
    None,
    {"onboarding_completed_at": None},
    {"onboarding_completed_at": "yesterday"},
    {"onboarding_completed_at": True},                          # a bool is not a time
    new(age=fr.WINDOW_SECONDS + 1),                             # a window ago
    {fr.CREATED_KEY: NOW + 3600},                               # stamped in the future
])
def test_an_account_that_is_not_new_has_no_welcome(data):
    assert fr.read(data, NOW)["state"] == "none"


def test_the_window_edge_is_inclusive():
    assert fr.read(new(age=fr.WINDOW_SECONDS), NOW)["state"] == "active"


@pytest.mark.parametrize("state", ["done", "skipped"])
def test_an_ended_welcome_stays_ended(state):
    data = fr.apply(new(), {"state": state}, NOW)
    assert fr.read(data, NOW)["state"] == state
    # a later write — a second tab — is answered with the record as it stands
    assert fr.apply(data, {"step": "meeting"}, NOW) == data
    assert fr.apply(data, {"state": "done" if state == "skipped" else "skipped"}, NOW) == data
    # and ending outlives the window
    assert fr.read(data, NOW + 30 * DAY)["state"] == state


def test_an_account_that_is_not_new_cannot_write_a_welcome():
    with pytest.raises(fr.Refused):
        fr.apply({}, {"step": "calendar"}, NOW)
    with pytest.raises(fr.Refused):
        fr.apply(new(age=fr.WINDOW_SECONDS + 1), {"state": "skipped"}, NOW)


@pytest.mark.parametrize("update", [
    None, {}, [], "skipped",
    {"step": "billing"}, {"step": 1}, {"step": None}, {"step": ["name"]},
    {"state": "active"}, {"state": "none"}, {"state": "pending"}, {"state": ""},
    {"user_id": 7}, {"step": "name", "extra": 1},
])
def test_a_body_outside_the_vocabulary_is_refused_whole(update):
    data = new()
    with pytest.raises(fr.Refused) as e:
        fr.apply(data, update, NOW)
    assert e.value.detail["refused"]
    assert data == new(), "a refused write must not touch the account"


def test_a_refusal_names_what_exists():
    with pytest.raises(fr.Refused) as e:
        fr.apply(new(), {"step": "billing"}, NOW)
    assert e.value.detail["steps"] == ["name", "calendar", "meeting"]


def test_a_write_keeps_the_rest_of_the_account_untouched():
    before = new(webhook_url="https://x.example", calendar_bot_name="Scribe")
    after = fr.apply(before, {"step": "meeting"}, NOW)
    assert {k: v for k, v in after.items() if k != fr.DATA_KEY} == before
    assert fr.DATA_KEY not in before, "apply must not mutate its input"


def test_a_malformed_record_reads_as_the_first_step():
    for rec in ("junk", 5, ["x"], {"step": "nope"}, {"state": "weird"}):
        assert fr.read(new(**{fr.DATA_KEY: rec}), NOW) == {"state": "active", "step": "name"}
