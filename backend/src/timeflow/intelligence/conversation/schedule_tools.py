"""Schedule Agent tools backed by the business service boundary."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from enum import StrEnum
from typing import TypeVar, cast

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    RecurringDeleteScope,
    ReminderStrength,
    ReminderType,
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleType,
    ScheduleUpdatePatch,
    UpdateScheduleCommand,
)
from timeflow.intelligence.conversation.llm import ToolDefinition

_EnumT = TypeVar("_EnumT", bound=StrEnum)
_MISSING = object()

_DATETIME_SCHEMA = {"type": ["string", "null"], "format": "date-time"}
_NULLABLE_STRING_SCHEMA = {"type": ["string", "null"]}
_REMINDER_TYPE_SCHEMA = {
    "type": ["string", "null"],
    "enum": [
        ReminderType.AT_TIME.value,
        ReminderType.BEFORE_START.value,
        ReminderType.ARRIVE_LOCATION.value,
        ReminderType.RETURN_TO_RECORDED_LOCATION.value,
        None,
    ],
}
_REMINDER_STRENGTH_SCHEMA = {
    "type": ["string", "null"],
    "enum": [
        ReminderStrength.LOW.value,
        ReminderStrength.MEDIUM.value,
        ReminderStrength.HIGH.value,
        None,
    ],
}
_EDITABLE_PROPERTIES: dict[str, object] = {
    "title": {"type": "string", "minLength": 1},
    "is_all_day": {"type": "boolean"},
    "start_time": _DATETIME_SCHEMA,
    "end_time": _DATETIME_SCHEMA,
    "timezone": {"type": "string", "minLength": 1},
    "recurrence_rule": _NULLABLE_STRING_SCHEMA,
    "location_name": _NULLABLE_STRING_SCHEMA,
    "latitude": {"type": ["number", "null"], "minimum": -90, "maximum": 90},
    "longitude": {"type": ["number", "null"], "minimum": -180, "maximum": 180},
    "reminder_type": _REMINDER_TYPE_SCHEMA,
    "reminder_trigger_at": _DATETIME_SCHEMA,
    "reminder_offset_minutes": {"type": ["integer", "null"], "minimum": 0},
    "reminder_strength": _REMINDER_STRENGTH_SCHEMA,
}


class ScheduleToolInputError(ValueError):
    """A schedule tool payload cannot be mapped to the business contract."""


@dataclass(frozen=True, slots=True)
class _ScheduleTool:
    definition: ToolDefinition
    service: ScheduleAgentService
    account_id: str

    async def execute(self, arguments: Mapping[str, object]) -> str:
        try:
            result = self._execute(arguments)
        except ScheduleBusinessError as exc:
            return _business_error_json(exc)
        return _result_json(result)

    def _execute(
        self,
        arguments: Mapping[str, object],
    ) -> ScheduleMutationResult | ScheduleSearchResult:
        name = self.definition.name
        if name == "schedule_create":
            return self.service.create_schedule(
                account_id=self.account_id,
                command=map_create_schedule_command(arguments),
            )
        if name == "schedule_query":
            return self.service.find_schedules(
                account_id=self.account_id,
                query=map_find_schedules_query(arguments),
            )
        if name == "schedule_update":
            return self.service.update_schedule(
                account_id=self.account_id,
                command=map_update_schedule_command(arguments),
            )
        if name == "schedule_delete":
            command = map_delete_schedule_command(arguments)
            if isinstance(command, DeleteOnceScheduleCommand):
                return self.service.delete_once_schedule(
                    account_id=self.account_id,
                    command=command,
                )
            return self.service.delete_recurring_schedule(
                account_id=self.account_id,
                command=command,
            )
        raise RuntimeError(f"Unsupported schedule tool: {name}")


@dataclass(frozen=True, slots=True)
class _LocationSearchPlaceholder:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        _reject_unknown(arguments, {"query", "nearby_latitude", "nearby_longitude"})
        _required_string(arguments, "query")
        _optional_float(arguments, "nearby_latitude", minimum=-90, maximum=90)
        _optional_float(arguments, "nearby_longitude", minimum=-180, maximum=180)
        return json.dumps(
            {
                "message": "地图地点搜索服务尚未接入",
                "status": "not_implemented",
                "tool": self.definition.name,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )


def build_schedule_tools(
    service: ScheduleAgentService,
    account_id: str,
) -> tuple[_ScheduleTool | _LocationSearchPlaceholder, ...]:
    """Build schedule and location tools for an authenticated account."""
    if not account_id.strip():
        raise ValueError("account_id must be non-empty")
    definitions = schedule_tool_definitions()
    return (
        _ScheduleTool(definitions[0], service, account_id),
        _ScheduleTool(definitions[1], service, account_id),
        _ScheduleTool(definitions[2], service, account_id),
        _ScheduleTool(definitions[3], service, account_id),
        _LocationSearchPlaceholder(definitions[4]),
    )


def schedule_tool_definitions() -> tuple[ToolDefinition, ...]:
    """Return LLM schemas aligned with the calendar business contracts."""
    return (
        ToolDefinition(
            "schedule_create",
            "Create a time or location schedule after required information is confirmed.",
            {
                "type": "object",
                "properties": {
                    "schedule_type": {
                        "type": "string",
                        "enum": [ScheduleType.TIME.value, ScheduleType.LOCATION.value],
                    },
                    "schedule_kind": {
                        "type": "string",
                        "enum": [ScheduleKind.ONCE.value, ScheduleKind.RECURRING.value],
                    },
                    **_EDITABLE_PROPERTIES,
                },
                "required": [
                    "schedule_type",
                    "schedule_kind",
                    "title",
                    "timezone",
                    "is_all_day",
                ],
                "additionalProperties": False,
            },
        ),
        ToolDefinition(
            "schedule_query",
            "Find schedules for listing, matching, disambiguation, update, or deletion.",
            {
                "type": "object",
                "properties": {
                    "schedule_id": _NULLABLE_STRING_SCHEMA,
                    "title": _NULLABLE_STRING_SCHEMA,
                    "starts_at_or_after": _DATETIME_SCHEMA,
                    "starts_before": _DATETIME_SCHEMA,
                    "location_name": _NULLABLE_STRING_SCHEMA,
                    "include_deleted": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
        ),
        ToolDefinition(
            "schedule_update",
            "Apply confirmed changes to one identified schedule.",
            {
                "type": "object",
                "properties": {
                    "schedule_id": {"type": "string", "minLength": 1},
                    "expected_revision": {"type": "integer", "minimum": 0},
                    "changes": {
                        "type": "object",
                        "properties": _EDITABLE_PROPERTIES,
                        "minProperties": 1,
                        "additionalProperties": False,
                    },
                },
                "required": ["schedule_id", "expected_revision", "changes"],
                "additionalProperties": False,
            },
        ),
        ToolDefinition(
            "schedule_delete",
            "Delete an identified schedule after confirmation; recurring schedules require scope.",
            {
                "type": "object",
                "properties": {
                    "schedule_id": {"type": "string", "minLength": 1},
                    "expected_revision": {"type": "integer", "minimum": 0},
                    "schedule_kind": {
                        "type": "string",
                        "enum": [ScheduleKind.ONCE.value, ScheduleKind.RECURRING.value],
                    },
                    "scope": {
                        "type": ["string", "null"],
                        "enum": [
                            RecurringDeleteScope.THIS_OCCURRENCE.value,
                            RecurringDeleteScope.THIS_AND_FUTURE.value,
                            RecurringDeleteScope.ENTIRE_SERIES.value,
                            None,
                        ],
                    },
                },
                "required": ["schedule_id", "expected_revision", "schedule_kind"],
                "additionalProperties": False,
            },
        ),
        ToolDefinition(
            "location_search",
            "Search for a location instead of inventing an address or coordinates.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "nearby_latitude": {
                        "type": ["number", "null"],
                        "minimum": -90,
                        "maximum": 90,
                    },
                    "nearby_longitude": {
                        "type": ["number", "null"],
                        "minimum": -180,
                        "maximum": 180,
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        ),
    )


def map_create_schedule_command(arguments: Mapping[str, object]) -> CreateScheduleCommand:
    """Map model arguments into the stable create business command."""
    allowed = {
        "schedule_type",
        "schedule_kind",
        *ScheduleUpdatePatch.__optional_keys__,
    }
    _reject_unknown(arguments, allowed)
    return CreateScheduleCommand(
        schedule_type=_required_enum(arguments, "schedule_type", ScheduleType),
        schedule_kind=_required_enum(arguments, "schedule_kind", ScheduleKind),
        title=_required_string(arguments, "title"),
        timezone=_required_string(arguments, "timezone"),
        is_all_day=_required_bool(arguments, "is_all_day"),
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
        raise ScheduleToolInputError("changes must be a non-empty object")
    changes = _map_update_patch(cast(Mapping[str, object], raw_changes))
    return UpdateScheduleCommand(
        schedule_id=_required_string(arguments, "schedule_id"),
        expected_revision=_required_int(arguments, "expected_revision", minimum=0),
        changes=changes,
    )


def map_delete_schedule_command(
    arguments: Mapping[str, object],
) -> DeleteOnceScheduleCommand | DeleteRecurringScheduleCommand:
    """Map one Agent delete tool into the appropriate stable business command."""
    _reject_unknown(arguments, {"schedule_id", "expected_revision", "schedule_kind", "scope"})
    schedule_id = _required_string(arguments, "schedule_id")
    revision = _required_int(arguments, "expected_revision", minimum=0)
    kind = _required_enum(arguments, "schedule_kind", ScheduleKind)
    scope = _optional_enum(arguments, "scope", RecurringDeleteScope)
    if kind is ScheduleKind.ONCE:
        if scope is not None:
            raise ScheduleToolInputError("scope is only valid for recurring schedules")
        return DeleteOnceScheduleCommand(schedule_id=schedule_id, expected_revision=revision)
    if scope is None:
        raise ScheduleToolInputError("scope is required for recurring schedules")
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
        raise ScheduleToolInputError(f"Unexpected fields: {', '.join(sorted(unknown))}")


def _required_string(arguments: Mapping[str, object], field: str) -> str:
    value = arguments.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ScheduleToolInputError(f"{field} must be a non-empty string")
    return value


def _optional_string(arguments: Mapping[str, object], field: str) -> str | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ScheduleToolInputError(f"{field} must be a string or null")
    return value


def _required_bool(arguments: Mapping[str, object], field: str) -> bool:
    value = arguments.get(field)
    if not isinstance(value, bool):
        raise ScheduleToolInputError(f"{field} must be a boolean")
    return value


def _optional_bool(arguments: Mapping[str, object], field: str, *, default: bool) -> bool:
    value = arguments.get(field, default)
    if not isinstance(value, bool):
        raise ScheduleToolInputError(f"{field} must be a boolean")
    return value


def _required_int(arguments: Mapping[str, object], field: str, *, minimum: int) -> int:
    value = arguments.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ScheduleToolInputError(
            f"{field} must be an integer greater than or equal to {minimum}"
        )
    return value


def _optional_int(arguments: Mapping[str, object], field: str, *, minimum: int) -> int | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ScheduleToolInputError(
            f"{field} must be an integer greater than or equal to {minimum}"
        )
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
        raise ScheduleToolInputError(f"{field} must be a number or null")
    result = float(value)
    if not minimum <= result <= maximum:
        raise ScheduleToolInputError(f"{field} must be between {minimum} and {maximum}")
    return result


def _optional_datetime(arguments: Mapping[str, object], field: str) -> datetime | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ScheduleToolInputError(f"{field} must be an ISO datetime string or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ScheduleToolInputError(f"{field} must be an ISO datetime string") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ScheduleToolInputError(f"{field} must include a timezone offset")
    return parsed


def _required_enum(arguments: Mapping[str, object], field: str, enum_type: type[_EnumT]) -> _EnumT:
    value = arguments.get(field)
    if not isinstance(value, str):
        raise ScheduleToolInputError(f"{field} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ScheduleToolInputError(f"{field} has an unsupported value") from exc


def _optional_enum(
    arguments: Mapping[str, object], field: str, enum_type: type[_EnumT]
) -> _EnumT | None:
    value = arguments.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ScheduleToolInputError(f"{field} must be a string or null")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ScheduleToolInputError(f"{field} has an unsupported value") from exc


def _result_json(result: ScheduleMutationResult | ScheduleSearchResult) -> str:
    return json.dumps(
        {"status": "ok", "result": _json_value(asdict(result))},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _business_error_json(error: ScheduleBusinessError) -> str:
    return json.dumps(
        {
            "status": "error",
            "error": {
                "code": error.code.value,
                "field": error.field,
                "message": error.message,
                "schedule_id": error.schedule_id,
            },
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _json_value(value: object) -> object:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


__all__ = [
    "ScheduleToolInputError",
    "build_schedule_tools",
    "map_create_schedule_command",
    "map_delete_schedule_command",
    "map_find_schedules_query",
    "map_update_schedule_command",
    "schedule_tool_definitions",
]
