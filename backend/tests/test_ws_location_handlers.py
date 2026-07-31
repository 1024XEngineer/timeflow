"""`LocationWebSocketHandlers` 的单元测试:解析 + 判定转发 + 调用 dispatch。"""

import asyncio
from datetime import datetime
from typing import Any

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.handlers.location import LocationWebSocketHandlers


class _RecordingConnections:
    """记录发送顺序,用来断言 ack 一定先于 reminder.control 发出。"""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, device_id: str, message: dict[str, Any]) -> bool:
        del device_id
        self.sent.append(message)
        return True


class _StubDispatcher:
    def __init__(self, connections: _RecordingConnections) -> None:
        self._connections = connections
        self.dispatched: list[tuple[list[TriggeredSchedule], datetime]] = []

    async def dispatch(self, schedules: list[TriggeredSchedule], now: datetime) -> None:
        self.dispatched.append((schedules, now))
        for schedule in schedules:
            # 模拟真实 ReminderDispatcher:命中的提醒也是走同一个 connections 发出去的
            await self._connections.send(
                schedule.user_id, {"type": "reminder.control", "schedule_id": schedule.schedule_id}
            )


def _report_message(**overrides: object) -> dict[str, object]:
    defaults: dict[str, object] = {
        "type": "location.report",
        "schedule_scope": "current",
        "latitude": 31.2451,
        "longitude": 121.5067,
        "accuracy": 18,
        "timestamp": "2026-07-30T12:00:00+08:00",
    }
    defaults.update(overrides)
    return defaults


def _handlers(
    run_report: Any,
) -> tuple[LocationWebSocketHandlers, _RecordingConnections, _StubDispatcher]:
    connections = _RecordingConnections()
    dispatcher = _StubDispatcher(connections)
    return LocationWebSocketHandlers(run_report, dispatcher, connections), connections, dispatcher


def test_handle_report_acks_before_dispatching_reminders() -> None:
    """正常上报:先回 location.report.ack,再推 reminder.control,顺序不能反。"""
    triggered = [
        TriggeredSchedule(schedule_id="schedule_1", user_id="device_1", reason="geofence_entered")
    ]
    calls: list[tuple[str, float, float]] = []

    def run_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        del now
        calls.append((user_id, latitude, longitude))
        return triggered

    async def scenario() -> None:
        handlers, connections, dispatcher = _handlers(run_report)

        response = await handlers.handle_report(_report_message(), "device_1")

        assert response is None  # 自己发,不通过路由层代发
        assert calls == [("device_1", 31.2451, 121.5067)]
        assert [message["type"] for message in connections.sent] == [
            "location.report.ack",
            "reminder.control",
        ]
        assert connections.sent[0] == {"type": "location.report.ack", "ok": True}
        assert dispatcher.dispatched[0][0] == triggered

    asyncio.run(scenario())


def test_handle_report_without_hits_only_sends_ack() -> None:
    """没有命中任何围栏时,只回 ack,不推任何提醒。"""

    def run_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        del user_id, latitude, longitude, now
        return []

    async def scenario() -> None:
        handlers, connections, _ = _handlers(run_report)

        await handlers.handle_report(_report_message(), "device_1")

        assert connections.sent == [{"type": "location.report.ack", "ok": True}]

    asyncio.run(scenario())


def test_handle_report_rejects_out_of_range_latitude() -> None:
    """纬度超出 [-90, 90] 范围,直接拒绝,不调用 run_report。"""
    calls: list[object] = []

    def run_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        calls.append((user_id, latitude, longitude, now))
        return []

    async def scenario() -> None:
        handlers, connections, dispatcher = _handlers(run_report)

        await handlers.handle_report(_report_message(latitude=91.0), "device_1")

        assert len(connections.sent) == 1
        response = connections.sent[0]
        assert response["type"] == "location.report.ack"
        assert response["ok"] is False
        assert response["error"]["code"] == "INVALID_LOCATION"
        assert response["error"]["details"]["field"] == "latitude"
        assert calls == []
        assert dispatcher.dispatched == []

    asyncio.run(scenario())


def test_handle_report_rejects_out_of_range_longitude() -> None:
    """经度超出 [-180, 180] 范围,直接拒绝。"""

    def run_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        raise AssertionError("不应该走到这里")

    async def scenario() -> None:
        handlers, connections, _ = _handlers(run_report)

        await handlers.handle_report(_report_message(longitude=181.0), "device_1")

        response = connections.sent[0]
        assert response["ok"] is False
        assert response["error"]["code"] == "INVALID_LOCATION"
        assert response["error"]["details"]["field"] == "longitude"

    asyncio.run(scenario())


def test_handle_report_rejects_malformed_message() -> None:
    """缺字段/类型不对,pydantic 校验失败,返回 INVALID_LOCATION。"""

    def run_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        raise AssertionError("不应该走到这里")

    async def scenario() -> None:
        handlers, connections, _ = _handlers(run_report)

        await handlers.handle_report({"type": "location.report", "latitude": 31.2451}, "device_1")

        response = connections.sent[0]
        assert response["ok"] is False
        assert response["error"]["code"] == "INVALID_LOCATION"

    asyncio.run(scenario())
