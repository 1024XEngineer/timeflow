"""Argument mapping and validation tests for the realtime schedule tools."""

from __future__ import annotations

from zoneinfo import ZoneInfo

import pytest

from timeflow.business.calendar import (
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    RecurringDeleteScope,
    ReminderStrength,
    ReminderType,
    ScheduleKind,
    ScheduleType,
)
from timeflow.intelligence.realtime.tool_mapping import (
    ToolInputError,
    map_create_schedule_command,
    map_delete_schedule_command,
    map_find_schedules_query,
    map_update_schedule_command,
    normalize_datetime_args,
)

TZ = ZoneInfo("Asia/Shanghai")

MINIMAL_CREATE = {
    "schedule_type": "time",
    "schedule_kind": "once",
    "title": "写周报",
}


def test_a_bare_datetime_is_read_as_local_time() -> None:
    arguments = normalize_datetime_args({"start_time": "2026-09-08T07:00:00"}, TZ)
    assert arguments["start_time"] == "2026-09-08T07:00:00+08:00"


def test_an_offset_the_model_supplied_is_left_alone() -> None:
    arguments = normalize_datetime_args({"start_time": "2026-09-08T07:00:00Z"}, TZ)
    assert arguments["start_time"] == "2026-09-08T07:00:00Z"


def test_a_negative_offset_the_model_supplied_is_left_alone() -> None:
    """A "+"/"Z" check alone would miss this and reattach the zone, shifting the instant."""
    arguments = normalize_datetime_args({"start_time": "2026-09-08T07:00:00-05:00"}, TZ)
    assert arguments["start_time"] == "2026-09-08T07:00:00-05:00"


def test_nested_change_datetimes_are_normalized_too() -> None:
    arguments = normalize_datetime_args({"changes": {"start_time": "2026-09-08T07:00:00"}}, TZ)
    assert arguments["changes"] == {"start_time": "2026-09-08T07:00:00+08:00"}


def test_text_that_only_looks_like_a_datetime_is_left_alone() -> None:
    arguments = normalize_datetime_args({"title": "Talk about T-shirts"}, TZ)
    assert arguments["title"] == "Talk about T-shirts"


def test_a_create_without_a_timezone_gets_the_deployment_zone() -> None:
    command = map_create_schedule_command(dict(MINIMAL_CREATE), TZ)
    assert command.timezone == str(TZ.key)
    assert command.is_all_day is False
    assert command.schedule_type is ScheduleType.TIME
    assert command.schedule_kind is ScheduleKind.ONCE


def test_a_create_carries_every_optional_field_through() -> None:
    command = map_create_schedule_command(
        {
            **MINIMAL_CREATE,
            "schedule_type": "location",
            "schedule_kind": "recurring",
            "timezone": "UTC",
            "is_all_day": True,
            "start_time": "2026-09-08T07:00:00+08:00",
            "end_time": "2026-09-08T08:00:00+08:00",
            "recurrence_rule": "FREQ=WEEKLY",
            "location_name": "公司",
            "latitude": 31.2,
            "longitude": 121.4,
            "reminder_type": "at_time",
            "reminder_trigger_at": "2026-09-08T06:30:00+08:00",
            "reminder_offset_minutes": 30,
            "reminder_strength": "high",
        },
        TZ,
    )
    assert command.timezone == "UTC"
    assert command.is_all_day is True
    assert command.recurrence_rule == "FREQ=WEEKLY"
    assert command.location_name == "公司"
    assert command.latitude == 31.2
    assert command.longitude == 121.4
    assert command.reminder_type is ReminderType.AT_TIME
    assert command.reminder_offset_minutes == 30
    assert command.reminder_strength is ReminderStrength.HIGH


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"nickname": "x"}, "Unexpected fields: nickname"),
        ({"title": ""}, "title must be a non-empty string"),
        ({"title": "   "}, "title must be a non-empty string"),
        ({"title": 7}, "title must be a non-empty string"),
        ({"schedule_type": "telepathy"}, "schedule_type has an unsupported value"),
        ({"schedule_type": 7}, "schedule_type must be a string"),
        ({"timezone": 7}, "timezone must be a string or null"),
        ({"is_all_day": "yes"}, "is_all_day must be a boolean"),
        ({"start_time": 7}, "start_time must be an ISO datetime string or null"),
        ({"start_time": "tomorrow"}, "start_time must be an ISO datetime string"),
        ({"start_time": "2026-09-08T07:00:00"}, "start_time must include a timezone offset"),
        ({"latitude": "north"}, "latitude must be a number or null"),
        ({"latitude": True}, "latitude must be a number or null"),
        ({"latitude": 91}, "latitude must be between -90 and 90"),
        ({"longitude": 181}, "longitude must be between -180 and 180"),
        ({"reminder_offset_minutes": -1}, "reminder_offset_minutes must be an integer"),
        ({"reminder_offset_minutes": True}, "reminder_offset_minutes must be an integer"),
        ({"reminder_type": 7}, "reminder_type must be a string or null"),
        ({"reminder_type": "telepathy"}, "reminder_type has an unsupported value"),
    ],
)
def test_a_create_the_contract_will_not_take_is_refused(
    overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(ToolInputError, match=message):
        map_create_schedule_command({**MINIMAL_CREATE, **overrides}, TZ)


def test_a_query_takes_every_filter() -> None:
    query = map_find_schedules_query(
        {
            "schedule_id": "sch_1",
            "title": "周报",
            "starts_at_or_after": "2026-09-08T00:00:00+08:00",
            "starts_before": "2026-09-09T00:00:00+08:00",
            "location_name": "公司",
            "include_deleted": True,
        }
    )
    assert query.schedule_id == "sch_1"
    assert query.include_deleted is True
    assert query.starts_at_or_after is not None
    assert query.starts_before is not None


def test_a_query_with_no_filters_still_maps() -> None:
    query = map_find_schedules_query({})
    assert query.schedule_id is None
    assert query.include_deleted is False


def test_a_query_field_that_is_not_a_filter_is_refused() -> None:
    with pytest.raises(ToolInputError, match="Unexpected fields: when"):
        map_find_schedules_query({"when": "tomorrow"})


def test_an_update_carries_every_patchable_field_through() -> None:
    command = map_update_schedule_command(
        {
            "schedule_id": "sch_1",
            "expected_revision": 3,
            "changes": {
                "title": "改过的标题",
                "is_all_day": True,
                "start_time": "2026-09-08T07:00:00+08:00",
                "end_time": "2026-09-08T08:00:00+08:00",
                "timezone": "UTC",
                "recurrence_rule": "FREQ=DAILY",
                "location_name": "家",
                "latitude": 31.2,
                "longitude": 121.4,
                "reminder_type": "before_start",
                "reminder_trigger_at": "2026-09-08T06:30:00+08:00",
                "reminder_offset_minutes": 15,
                "reminder_strength": "low",
            },
        }
    )
    assert command.schedule_id == "sch_1"
    assert command.expected_revision == 3
    assert command.changes["title"] == "改过的标题"
    assert command.changes["reminder_type"] is ReminderType.BEFORE_START
    assert command.changes["reminder_strength"] is ReminderStrength.LOW
    assert command.changes["reminder_offset_minutes"] == 15


def test_an_update_can_clear_a_field_by_naming_it_null() -> None:
    command = map_update_schedule_command(
        {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "changes": {"location_name": None, "recurrence_rule": None},
        }
    )
    # Present-and-None differs from absent: one clears the column, the other leaves it.
    assert command.changes["location_name"] is None
    assert "start_time" not in command.changes


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"schedule_id": "sch_1", "expected_revision": 1}, "changes must be a non-empty object"),
        (
            {"schedule_id": "sch_1", "expected_revision": 1, "changes": {}},
            "changes must be a non-empty object",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 1, "changes": "title"},
            "changes must be a non-empty object",
        ),
        ({"expected_revision": 1, "changes": {"title": "x"}}, "schedule_id must be a non-empty"),
        (
            {"schedule_id": "sch_1", "expected_revision": -1, "changes": {"title": "x"}},
            "expected_revision must be an integer",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": True, "changes": {"title": "x"}},
            "expected_revision must be an integer",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 1, "changes": {"colour": "red"}},
            "Unexpected fields: colour",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 1, "changes": {"is_all_day": "yes"}},
            "is_all_day must be a boolean",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 1, "changes": {"timezone": None}},
            "timezone must be a non-empty string",
        ),
        ({"schedule_id": "sch_1", "expected_revision": 1, "when": "x"}, "Unexpected fields: when"),
    ],
)
def test_an_update_the_contract_will_not_take_is_refused(
    payload: dict[str, object], message: str
) -> None:
    with pytest.raises(ToolInputError, match=message):
        map_update_schedule_command(payload)


def test_deleting_a_one_off_needs_no_scope() -> None:
    command = map_delete_schedule_command(
        {"schedule_id": "sch_1", "expected_revision": 2, "schedule_kind": "once"}
    )
    assert isinstance(command, DeleteOnceScheduleCommand)
    assert command.expected_revision == 2


def test_deleting_a_series_carries_the_scope() -> None:
    command = map_delete_schedule_command(
        {
            "schedule_id": "sch_1",
            "expected_revision": 2,
            "schedule_kind": "recurring",
            "scope": "entire_series",
        }
    )
    assert isinstance(command, DeleteRecurringScheduleCommand)
    assert command.scope is RecurringDeleteScope.ENTIRE_SERIES


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (
            {
                "schedule_id": "sch_1",
                "expected_revision": 2,
                "schedule_kind": "once",
                "scope": "entire_series",
            },
            "scope is only valid for recurring schedules",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 2, "schedule_kind": "recurring"},
            "scope is required for recurring schedules",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 2},
            "schedule_kind must be a string",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 2, "schedule_kind": "sometimes"},
            "schedule_kind has an unsupported value",
        ),
        (
            {
                "schedule_id": "sch_1",
                "expected_revision": 2,
                "schedule_kind": "recurring",
                "scope": 7,
            },
            "scope must be a string or null",
        ),
        (
            {
                "schedule_id": "sch_1",
                "expected_revision": 2,
                "schedule_kind": "recurring",
                "scope": "just_this_one_maybe",
            },
            "scope has an unsupported value",
        ),
        (
            {"schedule_id": "sch_1", "expected_revision": 2, "schedule_kind": "once", "why": "x"},
            "Unexpected fields: why",
        ),
    ],
)
def test_a_delete_the_contract_will_not_take_is_refused(
    payload: dict[str, object], message: str
) -> None:
    with pytest.raises(ToolInputError, match=message):
        map_delete_schedule_command(payload)
