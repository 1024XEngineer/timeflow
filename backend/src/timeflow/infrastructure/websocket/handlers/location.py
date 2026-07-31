"""WebSocket handlers for location reports (geofence trigger)."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import ValidationError

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.location import LocationReport, LocationReportAck


class _Dispatcher(Protocol):
    async def dispatch(self, schedules: list[TriggeredSchedule], now: datetime) -> None: ...


class _Sender(Protocol):
    async def send(self, device_id: str, message: dict[str, Any]) -> bool: ...


class LocationWebSocketHandlers:
    """Adapt `location.report` to the geofence trigger use case + reminder dispatch."""

    def __init__(
        self,
        run_report: Callable[[str, float, float, datetime], list[TriggeredSchedule]],
        dispatcher: _Dispatcher,
        connections: _Sender,
    ) -> None:
        self._run_report = run_report
        self._dispatcher = dispatcher
        self._connections = connections

    async def handle_report(self, raw_message: dict[str, Any], device_id: str) -> None:
        """Handle `location.report`: validate, judge geofence transitions, dispatch hits.

        自己发 `location.report.ack` 而不是 return 给路由层代发,是为了保证顺序:
        先把这次上报的 ack 回出去,再推可能命中的 `reminder.control`。如果 return 给
        路由层,dispatch 就必须发生在 return 之前,客户端会先收到提醒再收到 ack。
        """
        error = self._validate(raw_message)
        if error is not None:
            await self._connections.send(device_id, error)
            return None

        message = LocationReport.model_validate(raw_message)
        now = datetime.now(UTC)
        triggered = await asyncio.to_thread(
            self._run_report, device_id, message.latitude, message.longitude, now
        )
        await self._connections.send(
            device_id, LocationReportAck(ok=True).model_dump(exclude_none=True)
        )
        await self._dispatcher.dispatch(triggered, now)
        return None

    @staticmethod
    def _validate(raw_message: dict[str, Any]) -> dict[str, Any] | None:
        """返回错误信封;`None` 表示这条上报合法。"""
        try:
            message = LocationReport.model_validate(raw_message)
        except ValidationError as exc:
            return build_error_envelope(
                "location.report.ack",
                None,
                "INVALID_LOCATION",
                "位置信息不合法",
                {"errors": exc.errors()},
            )
        if not -90 <= message.latitude <= 90:
            return build_error_envelope(
                "location.report.ack",
                None,
                "INVALID_LOCATION",
                "位置信息不合法",
                {"field": "latitude"},
            )
        if not -180 <= message.longitude <= 180:
            return build_error_envelope(
                "location.report.ack",
                None,
                "INVALID_LOCATION",
                "位置信息不合法",
                {"field": "longitude"},
            )
        return None


__all__ = ["LocationWebSocketHandlers"]
