"""ReminderDispatcher 的单元测试。"""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.workers.reminder_dispatcher import ReminderDispatcher


class _FakeConnection:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


def _connections_with(user_id: str) -> tuple[ConnectionManager, _FakeConnection]:
    connections = ConnectionManager()
    connection = _FakeConnection()
    connections.register(user_id, connection)
    return connections, connection


def _triggered(
    schedule_id: str = "schedule_1",
    user_id: str = "user_1",
    reason: str = "time_window_reached",
) -> TriggeredSchedule:
    return TriggeredSchedule(schedule_id=schedule_id, user_id=user_id, reason=reason)


def test_tick_sends_reminder_control_when_online() -> None:
    """在线时,命中的日程会推一条 reminder.control,携带调用方指定的 reason。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [_triggered()])

        await dispatcher.tick(datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

        assert len(connection.sent) == 1
        message = connection.sent[0]
        assert message["type"] == "reminder.control"
        assert message["schedule_id"] == "schedule_1"
        assert message["reason"] == "time_window_reached"
        assert message["action"] == "show"

    asyncio.run(scenario())


def test_dispatch_handles_non_time_reasons() -> None:
    """dispatch() 是通用入口,事件驱动的触发来源(比如地理围栏)可以直接调用,
    不需要经过轮询的 run_tick;reason 原样透传。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [])

        geofence_hit = _triggered(reason="geofence_entered")
        await dispatcher.dispatch([geofence_hit], datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

        assert len(connection.sent) == 1
        assert connection.sent[0]["reason"] == "geofence_entered"

    asyncio.run(scenario())


def test_tick_offline_device_does_not_raise_or_track_pending() -> None:
    """设备离线时 send() 静默失败,不登记待确认、也不影响其他日程。"""

    async def scenario() -> None:
        connections = ConnectionManager()  # 没有注册任何连接
        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [_triggered()])

        await dispatcher.tick(datetime(2026, 7, 29, 15, 0, tzinfo=UTC))
        # 离线情况下没有登记待确认项,后续超时扫描不应该重发任何东西
        await dispatcher.tick(datetime(2026, 7, 29, 15, 10, tzinfo=UTC))

    asyncio.run(scenario())


def test_handle_ack_clears_pending() -> None:
    """收到 ack 后,这条日程不再需要等待,超时扫描不会重发。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, ack_timeout_seconds=30.0)
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.handle_ack("schedule_1")
        await dispatcher.tick(sent_at + timedelta(seconds=31))

        assert connection.sent == []

    asyncio.run(scenario())


def test_handle_ack_for_unknown_schedule_is_noop() -> None:
    """从未登记过的 schedule_id 收到 ack(或者已经被超时清理过),直接丢弃,不报错。"""

    async def scenario() -> None:
        connections, _ = _connections_with("user_1")
        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [])

        await dispatcher.handle_ack("schedule_unknown")

    asyncio.run(scenario())


def test_ack_timeout_resends_same_reminder() -> None:
    """超过 ack 超时阈值还没收到确认,会重发一次同样的 reminder.control。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, ack_timeout_seconds=30.0)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=31))

        assert len(connection.sent) == 1
        assert connection.sent[0]["type"] == "reminder.control"
        assert connection.sent[0]["schedule_id"] == "schedule_1"

    asyncio.run(scenario())


def test_within_ack_timeout_window_does_not_resend_yet() -> None:
    """还没超过 ack 超时阈值时,不会提前重发。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, ack_timeout_seconds=30.0)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=10))

        assert connection.sent == []

    asyncio.run(scenario())


def test_gives_up_after_max_attempts() -> None:
    """达到最大重试次数后不再重发,登记也被清除。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], [], [], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0) if batches else []

        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        dispatcher = ReminderDispatcher(
            connections, run_tick=run_tick, ack_timeout_seconds=30.0, max_attempts=2
        )
        await dispatcher.tick(sent_at)  # attempt 1
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=31))  # attempt 2(重发一次)
        assert len(connection.sent) == 1
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=62))  # 超过 max_attempts,放弃

        assert connection.sent == []

    asyncio.run(scenario())
