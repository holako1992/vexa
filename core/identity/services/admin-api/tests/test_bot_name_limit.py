"""One bot-name limit for every door that writes `users.data.calendar_bot_name`.

The default bot name has three writers — `PUT /user/calendar`, the calendar connections'
`validate_bot_name`, and the person-settings vocabulary the agent's tools write through. They store
one value, so they keep one limit: a name one door accepts is never cut short by another.
Pure — no database.
"""
import pytest
from fastapi import HTTPException

from admin_api.app.calendars import validate_bot_name
from admin_api.app.person_settings import BOT_NAME_KEY, BOT_NAME_MAX, coerce


def test_the_longest_accepted_name_is_kept_whole_by_every_door():
    name = "n" * BOT_NAME_MAX
    assert validate_bot_name(name) == name
    assert coerce(BOT_NAME_KEY, name) == name


def test_one_character_over_is_refused():
    with pytest.raises(HTTPException) as refused:
        validate_bot_name("n" * (BOT_NAME_MAX + 1))
    assert refused.value.status_code == 422
