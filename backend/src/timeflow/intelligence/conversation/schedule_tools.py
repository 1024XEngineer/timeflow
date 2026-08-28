"""Schedule Agent tools backed by the business service boundary."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol, TypeVar, cast
from zoneinfo import ZoneInfo

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
    ScheduleCategory,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleType,
    ScheduleUpdatePatch,
    UpdateScheduleCommand,
)
from timeflow.intelligence.conversation.llm import ToolDefinition

# intelligence.location.tools imports conversation.llm (for ToolDefinition), and this
# module is reached while the conversation package is still initializing (llm -> package
# __init__ -> agent -> tools -> here) -- a real top-level import of intelligence.location
# would re-enter it before its own imports finish. TYPE_CHECKING keeps annotations
# resolvable for mypy without executing at runtime; build_schedule_tools() imports the
# two functions it actually calls locally, once both packages have finished initializing.
if TYPE_CHECKING:
    from timeflow.intelligence.location import (
        ClientLocation,
        LocationSearchContext,
        LocationSearchService,
        LocationSearchTool,
    )
    from timeflow.intelligence.location.tools import (
        _LazyLocationSearchTool,
        _UnavailableLocationSearchTool,
    )

_EnumT = TypeVar("_EnumT", bound=StrEnum)
_MISSING = object()

logger = logging.getLogger(__name__)

_DATETIME_SCHEMA = {"type": ["string", "null"], "format": "date-time"}
_NULLABLE_STRING_SCHEMA = {"type": ["string", "null"]}
_CATEGORY_SCHEMA = {
    "type": ["string", "null"],
    "enum": [*(category.value for category in ScheduleCategory), None],
}
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
    "latitude": {
        "type": ["number", "null"],
        "minimum": -90,
        "maximum": 90,
        "description": "地点日程纬度，必须来自 location_search 返回候选的 latitude，禁止编造",
    },
    "longitude": {
        "type": ["number", "null"],
        "minimum": -180,
        "maximum": 180,
        "description": "地点日程经度，必须来自 location_search 返回候选的 longitude，禁止编造",
    },
    "reminder_type": _REMINDER_TYPE_SCHEMA,
    "reminder_trigger_at": _DATETIME_SCHEMA,
    "reminder_offset_minutes": {"type": ["integer", "null"], "minimum": 0},
    "reminder_strength": _REMINDER_STRENGTH_SCHEMA,
}


class ScheduleToolInputError(ValueError):
    """A schedule tool payload cannot be mapped to the business contract."""


class ScheduleResultObserver(Protocol):
    """Observe successful schedule mutations and queries."""

    async def succeeded(
        self,
        operation: str,
        result: ScheduleMutationResult | ScheduleSearchResult,
    ) -> None:
        """Report one successful tool result after the business service returns."""
        ...


@dataclass(frozen=True, slots=True)
class _ScheduleTool:
    definition: ToolDefinition
    service: ScheduleAgentService
    account_id: str
    observer: ScheduleResultObserver | None = None

    async def execute(self, arguments: Mapping[str, object]) -> str:
        if self.definition.name == "schedule_query":
            logger.info(
                "schedule_query args=%s",
                json.dumps(arguments, ensure_ascii=False, sort_keys=True),
            )
        execution = asyncio.create_task(asyncio.to_thread(self._execute, arguments))
        cancelled = False
        try:
            result = await asyncio.shield(execution)
        except asyncio.CancelledError:
            cancelled = True
            try:
                result = await execution
            except ScheduleBusinessError:
                raise asyncio.CancelledError from None
        except ScheduleBusinessError as exc:
            return _business_error_json(exc)
        except ScheduleToolInputError as exc:
            return _refusal_json(str(exc))
        await self._notify_observer(result)
        if cancelled:
            raise asyncio.CancelledError
        return _result_json(result)

    async def _notify_observer(
        self,
        result: ScheduleMutationResult | ScheduleSearchResult,
    ) -> None:
        if self.observer is None:
            return
        observer_task = asyncio.create_task(self.observer.succeeded(self.definition.name, result))
        try:
            await asyncio.shield(observer_task)
        except asyncio.CancelledError:
            await observer_task
            raise

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


def build_schedule_tools(
    service: ScheduleAgentService,
    account_id: str,
    observer: ScheduleResultObserver | None = None,
    *,
    location_service: LocationSearchService | None = None,
    location_context: LocationSearchContext | None = None,
    client_location: ClientLocation | None = None,
) -> tuple[
    _ScheduleTool | LocationSearchTool | _LazyLocationSearchTool | _UnavailableLocationSearchTool,
    ...,
]:
    """Build schedule and location tools for an authenticated account.

    location_search resolves in one of three ways, matching the Realtime Agent's
    ToolBox:

    * service + prepared context -- a real, ready search;
    * service + client_location -- a search that prepares lazily and retries a
      failed prepare on the next call;
    * neither -- the unavailable stand-in, which reports provider_unavailable
      rather than withholding the tool from the schema.
    """
    from timeflow.intelligence.location import (
        build_lazy_location_search_tool,
        build_location_search_tool,
        build_unavailable_location_search_tool,
    )

    if not account_id.strip():
        raise ValueError("account_id must be non-empty")
    definitions = schedule_tool_definitions()
    location_tool: LocationSearchTool | _LazyLocationSearchTool | _UnavailableLocationSearchTool
    if location_service is not None and location_context is not None:
        location_tool = build_location_search_tool(location_service, location_context)
    elif location_service is not None and client_location is not None:
        location_tool = build_lazy_location_search_tool(location_service, client_location)
    else:
        location_tool = build_unavailable_location_search_tool()
    return (
        _ScheduleTool(definitions[0], service, account_id, observer),
        _ScheduleTool(definitions[1], service, account_id, observer),
        _ScheduleTool(definitions[2], service, account_id, observer),
        _ScheduleTool(definitions[3], service, account_id, observer),
        location_tool,
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
                        "description": "用户提到具体地点用 location，否则用 time；不要为此反问用户",
                    },
                    "schedule_kind": {
                        "type": "string",
                        "enum": [ScheduleKind.ONCE.value, ScheduleKind.RECURRING.value],
                        "description": "用户明确说要重复用 recurring，否则用 once；不要为此反问用户",
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
                    "category": _CATEGORY_SCHEMA,
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
            "Delete an identified schedule only after the user explicitly confirms; recurring schedules require scope.",
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
    )


def map_create_schedule_command(arguments: Mapping[str, object]) -> CreateScheduleCommand:
    """Map model arguments into the stable create business command."""
    allowed = {
        "schedule_type",
        "schedule_kind",
        *ScheduleUpdatePatch.__optional_keys__,
    }
    _reject_unknown(arguments, allowed)
    schedule_type = _required_enum(arguments, "schedule_type", ScheduleType)
    location_name = _optional_string(arguments, "location_name")
    _reject_vague_location(schedule_type, location_name)
    return CreateScheduleCommand(
        schedule_type=schedule_type,
        schedule_kind=_required_enum(arguments, "schedule_kind", ScheduleKind),
        title=_required_string(arguments, "title"),
        timezone=_required_string(arguments, "timezone"),
        is_all_day=_required_bool(arguments, "is_all_day"),
        start_time=_optional_datetime(arguments, "start_time"),
        end_time=_optional_datetime(arguments, "end_time"),
        recurrence_rule=_optional_string(arguments, "recurrence_rule"),
        location_name=location_name,
        latitude=_optional_float(arguments, "latitude", minimum=-90, maximum=90),
        longitude=_optional_float(arguments, "longitude", minimum=-180, maximum=180),
        reminder_type=_optional_enum(arguments, "reminder_type", ReminderType),
        reminder_trigger_at=_optional_datetime(arguments, "reminder_trigger_at"),
        reminder_offset_minutes=_optional_int(arguments, "reminder_offset_minutes", minimum=0),
        reminder_strength=_optional_enum(arguments, "reminder_strength", ReminderStrength),
    )


def _reject_vague_location(schedule_type: ScheduleType, location_name: str | None) -> None:
    """Refuse a location schedule whose place is still only a personal/relative reference.

    「家」「公司」这类模糊指代不携带真实坐标，无法建成地点日程；硬性拦截，强制模型改走
    request_user_input 向用户追问具体地点，而不是拿模糊词直接创建。
    """
    if schedule_type is not ScheduleType.LOCATION or location_name is None:
        return
    # 延迟导入避免 conversation -> location -> conversation.llm 的循环（见文件头注释）。
    from timeflow.intelligence.location.references import is_personal_place_reference

    if is_personal_place_reference(location_name):
        raise ScheduleToolInputError(
            f"location_name「{location_name}」是模糊指代，不是具体地点；"
            "请调用 request_user_input 自然地问具体位置（如对「家」问「你家的地址是？」），"
            "拿到精确地名后再创建。"
        )


def map_find_schedules_query(arguments: Mapping[str, object]) -> FindSchedulesQuery:
    """Map model arguments into the stable schedule query."""
    allowed = {
        "schedule_id",
        "title",
        "starts_at_or_after",
        "starts_before",
        "location_name",
        "category",
        "include_deleted",
    }
    _reject_unknown(arguments, allowed)
    return FindSchedulesQuery(
        schedule_id=_optional_string(arguments, "schedule_id"),
        title=_optional_string(arguments, "title"),
        starts_at_or_after=_optional_datetime(arguments, "starts_at_or_after"),
        starts_before=_optional_datetime(arguments, "starts_before"),
        location_name=_optional_string(arguments, "location_name"),
        category=_optional_enum(arguments, "category", ScheduleCategory),
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
    value = _coerce_int(arguments.get(field), field)
    if value is None or value < minimum:
        raise ScheduleToolInputError(
            f"{field} must be an integer greater than or equal to {minimum}"
        )
    return value


def _optional_int(arguments: Mapping[str, object], field: str, *, minimum: int) -> int | None:
    raw = arguments.get(field)
    if raw is None:
        return None
    value = _coerce_int(raw, field)
    if value is None or value < minimum:
        raise ScheduleToolInputError(
            f"{field} must be an integer greater than or equal to {minimum}"
        )
    return value


def _coerce_int(value: object, field: str) -> int | None:
    """Accept a native int or an integer-valued numeric string.

    See the Realtime Agent's identical fix in intelligence/realtime/tool_mapping.py.
    """
    if isinstance(value, bool):
        raise ScheduleToolInputError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            raise ScheduleToolInputError(f"{field} must be an integer") from None
    raise ScheduleToolInputError(f"{field} must be an integer")


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
    if isinstance(value, bool):
        raise ScheduleToolInputError(f"{field} must be a number or null")
    if isinstance(value, str):
        # See the Realtime Agent's identical fix in intelligence/realtime/tool_mapping.py:
        # the model sometimes quotes a long-precision location_search coordinate when
        # copying it verbatim into schedule_create, and never self-corrects on retry.
        try:
            value = float(value)
        except ValueError:
            raise ScheduleToolInputError(f"{field} must be a number or null") from None
    elif not isinstance(value, (int, float)):
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
        {
            "status": "ok",
            "result": {"schedules": [_schedule_for_llm(s) for s in result.schedules]},
        },
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


def _refusal_json(reason: str) -> str:
    """Tell the model a tool payload was unusable so it can retry with valid input."""
    return json.dumps(
        {"status": "failed", "error": {"message": reason}},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _schedule_for_llm(snapshot: ScheduleSnapshot) -> dict[str, object]:
    """Serialize one schedule for the LLM, trimming fields the model never uses.

    The model only references (id, revision), decides on (schedule_kind,
    schedule_type), or reports (title, times, recurrence, location, reminder).
    Account scoping, status, timestamps, coordinates, and reminder disposition
    are internal noise that would bloat every turn's conversation history.
    """
    tz = ZoneInfo(snapshot.timezone)
    return {
        "id": snapshot.id,
        "title": snapshot.title,
        "schedule_type": snapshot.schedule_type.value,
        "schedule_kind": snapshot.schedule_kind.value,
        "is_all_day": snapshot.is_all_day,
        "start_time": _iso_or_none(snapshot.start_time),
        "end_time": _iso_or_none(snapshot.end_time),
        "starts_at_local": _local_text(snapshot.start_time, tz),
        "recurrence_rule": snapshot.recurrence_rule,
        "location_name": snapshot.location_name,
        "reminder_type": None if snapshot.reminder_type is None else snapshot.reminder_type.value,
        "reminder_trigger_at": _iso_or_none(snapshot.reminder_trigger_at),
        "reminder_offset_minutes": snapshot.reminder_offset_minutes,
        "revision": snapshot.revision,
    }


def _local_text(instant: datetime | None, tz: ZoneInfo) -> str:
    """Render a stored instant as local wall-clock text for the model to speak.

    The ISO ``start_time`` keeps the exact offset for tool arguments, but the model
    tends to read the clock digits verbatim when answering, ignoring the offset. A
    UTC-stored instant (``10:00+00:00``) would then be spoken as "上午十点" instead of
    the user's "下午六点". This companion field renders the same instant in the
    schedule's own IANA zone, so the digits already match what the user meant.
    """
    if instant is None:
        return ""
    return instant.astimezone(tz).strftime("%Y-%m-%d %H:%M")


def _iso_or_none(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


__all__ = [
    "ScheduleResultObserver",
    "ScheduleToolInputError",
    "build_schedule_tools",
    "map_create_schedule_command",
    "map_delete_schedule_command",
    "map_find_schedules_query",
    "map_update_schedule_command",
    "schedule_tool_definitions",
]
