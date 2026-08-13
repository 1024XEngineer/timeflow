"""Argument mapping and validation for schedule tools."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from enum import StrEnum
from typing import TypeVar
from zoneinfo import ZoneInfo

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    RecurringDeleteScope,
    ReminderStrength,
    ReminderType,
    ScheduleKind,
    ScheduleType,
    ScheduleUpdatePatch,
    UpdateScheduleCommand,
)

_EnumT = TypeVar("_EnumT", bound=StrEnum)


class ToolInputError(ValueError):
    """A tool payload cannot be mapped to the business contract."""


def normalize_datetime_args(arguments: dict[str, object], tz: ZoneInfo) -> dict[str, object]:
    """Add local timezone offset to datetime strings that lack one.

    Mutates and returns the input dict for chaining.
    """
    for key, value in arguments.items():
        if isinstance(value, str) and "T" in value:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                continue
            # A "+" or "Z" check alone misses negative offsets like "-05:00", which
            # fromisoformat parses as already aware -- reattaching tz to those would
            # silently shift the instant by the difference between the two zones.
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                arguments[key] = parsed.replace(tzinfo=tz).isoformat()
        elif isinstance(value, dict):
            normalize_datetime_args(value, tz)
    return arguments


def map_create_schedule_command(
    arguments: Mapping[str, object], tz: ZoneInfo
) -> CreateScheduleCommand:
    """Map model arguments into the stable create business command."""
    allowed = {"schedule_type", "schedule_kind", *ScheduleUpdatePatch.__optional_keys__}
    _reject_unknown(arguments, allowed)
    return CreateScheduleCommand(
        schedule_type=_required_enum(arguments, "schedule_type", ScheduleType),
        schedule_kind=_required_enum(arguments, "schedule_kind", ScheduleKind),
        title=_required_string(arguments, "title"),
        # Both default rather than being asked of the model: one deployment, one zone, and
        # a model made to state them every call is a model that eventually invents them.
        timezone=_optional_string(arguments, "timezone") or str(tz.key),
        is_all_day=_optional_bool(arguments, "is_all_day", default=False),
        start_time=_optional_datetime(arguments, "start_time"),
        end_time=_optional_datetime(arguments, "end_time"),
        recurrence_rule=_optional_string(arguments, "recurrence_rule"),
        location_name=_optional_string(arguments, "location_name"),
        latitude=_optional_float(arguments, "latitude", minimum=-90, maximum=90),
        longitude=_optional_float(arguments, "longitude", minimum=-180, maximum=180),
        reminder_type=_optional_enum(arguments, "reminder_type", ReminderType),
        reminder_trigger_at=_optional_datetime(arguments, "reminder_trigger_at"),
        reminder_offset_minutes=_optional_int(arguments, "reminder_offset_minutes", minimum=0),
        reminder_strength=_optional_enum(arguments, "reminder_strength", ReminderStrength),
    )


def map_find_schedules_query(arguments: Mapping[str, object]) -> FindSchedulesQuery:
    """Map model arguments into the stable schedule query."""
    allowed = {
        "schedule_id",
        "title",
        "starts_at_or_after",
        "starts_before",
        "location_name",
        "include_deleted",
    }
    _reject_unknown(arguments, allowed)
    return FindSchedulesQuery(
        schedule_id=_optional_string(arguments, "schedule_id"),
        title=_optional_string(arguments, "title"),
        starts_at_or_after=_optional_datetime(arguments, "starts_at_or_after"),
        starts_before=_optional_datetime(arguments, "starts_before"),
        location_name=_optional_string(arguments, "location_name"),
        include_deleted=_optional_bool(arguments, "include_deleted", default=False),
    )


def map_update_schedule_command(arguments: Mapping[str, object]) -> UpdateScheduleCommand:
    """Map model arguments into the stable update business command."""
    _reject_unknown(arguments, {"schedule_id", "expected_revision", "changes"})
    raw_changes = arguments.get("changes")
    if not isinstance(raw_changes, dict) or not raw_changes:
        raise ToolInputError("changes must be a non-empty object")
    from typing import cast

    changes = _map_update_patch(cast(Mapping[str, object], raw_changes))
    return UpdateScheduleCommand(
        schedule_id=_required_string(arguments, "schedule_id"),
        expected_revision=_required_int(arguments, "expected_revision", minimum=0),
        changes=changes,
    )


def map_delete_schedule_command(
    arguments: Mapping[str, object],
) -> DeleteOnceScheduleCommand | DeleteRecurringScheduleCommand:
    """Map one delete tool into the appropriate stable business command."""
    _reject_unknown(arguments, {"schedule_id", "expected_revision", "schedule_kind", "scope"})
    schedule_id = _required_string(arguments, "schedule_id")
    revision = _required_int(arguments, "expected_revision", minimum=0)
    kind = _required_enum(arguments, "schedule_kind", ScheduleKind)
    scope = _optional_enum(arguments, "scope", RecurringDeleteScope)
    if kind is ScheduleKind.ONCE:
        if scope is not None:
            raise ToolInputError("scope is only valid for recurring schedules")
        return DeleteOnceScheduleCommand(schedule_id=schedule_id, expected_revision=revision)
    if scope is None:
        raise ToolInputError("scope is required for recurring schedules")
    return DeleteRecurringScheduleCommand(
        schedule_id=schedule_id,
        expected_revision=revision,
        scope=scope,
    )


def _map_update_patch(arguments: Mapping[str, object]) -> ScheduleUpdatePatch:
    _reject_unknown(arguments, set(ScheduleUpdatePatch.__optional_keys__))
    changes: ScheduleUpdatePatch = {}
    if "title" in arguments:
        changes["title"] = _required_string(arguments, "title")
    if "is_all_day" in arguments:
        changes["is_all_day"] = _required_bool(arguments, "is_all_day")
    if "start_time" in arguments:
        changes["start_time"] = _optional_datetime(arguments, "start_time")
    if "end_time" in arguments:
        changes["end_time"] = _optional_datetime(arguments, "end_time")
    if "timezone" in arguments:
        changes["timezone"] = _required_string(arguments, "timezone")
    if "recurrence_rule" in arguments:
        changes["recurrence_rule"] = _optional_string(arguments, "recurrence_rule")
    if "location_name" in arguments:
        changes["location_name"] = _optional_string(arguments, "location_name")
    if "latitude" in arguments:
        changes["latitude"] = _optional_float(arguments, "latitude", minimum=-90, maximum=90)
    if "longitude" in arguments:
        changes["longitude"] = _optional_float(arguments, "longitude", minimum=-180, maximum=180)
    if "reminder_type" in arguments:
        changes["reminder_type"] = _optional_enum(arguments, "reminder_type", ReminderType)
    if "reminder_trigger_at" in arguments:
        changes["reminder_trigger_at"] = _optional_datetime(arguments, "reminder_trigger_at")
    if "reminder_offset_minutes" in arguments:
        changes["reminder_offset_minutes"] = _optional_int(
            arguments, "reminder_offset_minutes", minimum=0
        )
    if "reminder_strength" in arguments:
        changes["reminder_strength"] = _optional_enum(
            arguments, "reminder_strength", ReminderStrength
        )
    return changes


def _reject_unknown(arguments: Mapping[str, object], allowed: set[str]) -> None:
    unknown = set(arguments) - allowed
    if unknown:
        raise ToolInputError(f"Unexpected fields: {', '.join(sorted(unknown))}")


def _required_string(arguments: Mapping[str, object], field: str) -> str:
    value = arguments.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ToolInputError(f"{field} must be a non-empty string")
    return value


def _optional_string(arguments: Mapping[str, object], field: str) -> str | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ToolInputError(f"{field} must be a string or null")
    return value


def _required_bool(arguments: Mapping[str, object], field: str) -> bool:
    value = arguments.get(field)
    if not isinstance(value, bool):
        raise ToolInputError(f"{field} must be a boolean")
    return value


def _optional_bool(arguments: Mapping[str, object], field: str, *, default: bool) -> bool:
    value = arguments.get(field, default)
    if not isinstance(value, bool):
        raise ToolInputError(f"{field} must be a boolean")
    return value


def _required_int(arguments: Mapping[str, object], field: str, *, minimum: int) -> int:
    value = arguments.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ToolInputError(f"{field} must be an integer greater than or equal to {minimum}")
    return value


def _optional_int(arguments: Mapping[str, object], field: str, *, minimum: int) -> int | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ToolInputError(f"{field} must be an integer greater than or equal to {minimum}")
    return value


def _optional_float(
    arguments: Mapping[str, object],
    field: str,
    *,
    minimum: float,
    maximum: float,
) -> float | None:
    value = arguments.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ToolInputError(f"{field} must be a number or null")
    result = float(value)
    if not minimum <= result <= maximum:
        raise ToolInputError(f"{field} must be between {minimum} and {maximum}")
    return result


def _optional_datetime(arguments: Mapping[str, object], field: str) -> datetime | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ToolInputError(f"{field} must be an ISO datetime string or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ToolInputError(f"{field} must be an ISO datetime string") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ToolInputError(f"{field} must include a timezone offset")
    return parsed


def _required_enum(arguments: Mapping[str, object], field: str, enum_type: type[_EnumT]) -> _EnumT:
    value = arguments.get(field)
    if not isinstance(value, str):
        raise ToolInputError(f"{field} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ToolInputError(f"{field} has an unsupported value") from exc


def _optional_enum(
    arguments: Mapping[str, object], field: str, enum_type: type[_EnumT]
) -> _EnumT | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ToolInputError(f"{field} must be a string or null")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ToolInputError(f"{field} has an unsupported value") from exc
