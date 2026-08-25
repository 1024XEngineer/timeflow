"""Successful schedule result delivery for one composed conversation."""

from __future__ import annotations

from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import asdict
from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import uuid4

from timeflow.business.calendar import (
    ScheduleMutationResult,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSearchResult,
    ScheduleSnapshot,
)
from timeflow.intelligence.conversation.schedule_tools import ScheduleResultObserver
from timeflow.intelligence.ports import CommandResult, ResultSink, StreamInfo


class ScheduleResultDelivery(ScheduleResultObserver):
    """Deliver successful schedule tools against the currently bound turn."""

    def __init__(
        self,
        sink: ResultSink,
        *,
        message_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._sink = sink
        self._message_id_factory = message_id_factory or (lambda: f"msg_{uuid4().hex}")
        self._stream: ContextVar[StreamInfo | None] = ContextVar(
            "composed_schedule_result_stream",
            default=None,
        )

    def bind(self, stream: StreamInfo) -> None:
        """Bind tool callbacks in the current turn task to their originating stream."""
        self._stream.set(stream)

    async def succeeded(
        self,
        operation: str,
        result: ScheduleMutationResult | ScheduleSearchResult,
    ) -> None:
        stream = self._stream.get()
        if stream is None:
            return
        await self._sink.deliver_result(
            _command_result(self._message_id_factory(), operation, result), stream
        )


def _command_result(
    message_id: str,
    tool_name: str,
    result: ScheduleMutationResult | ScheduleSearchResult,
) -> CommandResult:
    if tool_name == "schedule_query":
        if not isinstance(result, ScheduleSearchResult):
            raise ValueError("schedule_query must return ScheduleSearchResult")
        return CommandResult(
            message_id,
            "list_schedules",
            "applied",
            schedules=[_snapshot_for_client(item) for item in result.schedules],
        )
    if not isinstance(result, ScheduleMutationResult):
        raise ValueError(f"{tool_name} must return ScheduleMutationResult")
    operations = {
        "schedule_create": "create_schedule",
        "schedule_update": "update_schedule",
        "schedule_delete": "delete_schedule",
    }
    try:
        operation = operations[tool_name]
    except KeyError as exc:
        raise ValueError(f"Unsupported successful schedule operation: {tool_name}") from exc
    snapshot = result.schedules[0] if result.schedules else None
    schedules = [_snapshot_for_client(item) for item in result.schedules]
    overrides = [_override_for_client(item) for item in result.occurrence_overrides]
    return CommandResult(
        message_id,
        operation,
        "applied",
        schedule=_snapshot_for_client(snapshot) if snapshot is not None else None,
        schedules=schedules or None,
        occurrence_overrides=overrides or None,
    )


def _snapshot_for_client(snapshot: ScheduleSnapshot) -> dict[str, Any]:
    """Match the Realtime Agent's client snapshot exactly."""
    return {
        key: cast(Any, _json_value(value))
        for key, value in asdict(snapshot).items()
        if key not in {"account_id", "created_at", "updated_at", "deleted_at"}
    }


def _override_for_client(override: ScheduleOccurrenceOverrideSnapshot) -> dict[str, Any]:
    """Match the Realtime Agent's client override exactly."""
    return {
        key: cast(Any, _json_value(value))
        for key, value in asdict(override).items()
        if key not in {"created_at", "updated_at"}
    }


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


# Compatibility alias for the already migrated composed session module.
CommittedResultDelivery = ScheduleResultDelivery

__all__ = ["CommittedResultDelivery", "ScheduleResultDelivery"]
