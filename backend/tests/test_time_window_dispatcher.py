"""TimeWindowDispatcher 的单元测试。"""

import asyncio
from datetime import datetime, timedelta
from typing import Any

from timeflow.business.schedules.reminder_dispatch import NextStep, TriggeredSchedule
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.workers.time_window_dispatcher import TimeWindowDispatcher


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


def test_ready_to_remind_sends_reminder_and_cleanup() -> None:
    """READY_TO_REMIND(带系统引用)会推 reminder.control 和 system.schedule.delete。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        triggered = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.READY_TO_REMIND,
            )
        ]
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: triggered,
            cancel_schedule=lambda schedule_id: None,
        )

        await dispatcher.tick(datetime(2026, 7, 29, 15, 0))

        types = [message["type"] for message in connection.sent]
        assert types == ["reminder.control", "system.schedule.delete"]

    asyncio.run(scenario())


def test_ready_to_remind_without_ref_sends_only_reminder() -> None:
    """没有系统引用的 READY_TO_REMIND 只推 reminder.control。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        triggered = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id=None,
                next_step=NextStep.READY_TO_REMIND,
            )
        ]
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: triggered,
            cancel_schedule=lambda schedule_id: None,
        )

        await dispatcher.tick(datetime(2026, 7, 29, 15, 0))

        types = [message["type"] for message in connection.sent]
        assert types == ["reminder.control"]

    asyncio.run(scenario())


def test_needs_refs_check_sends_check_only() -> None:
    """NEEDS_REFS_CHECK 只发 system.refs.check,还没收到回复前不会推提醒。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        triggered = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.NEEDS_REFS_CHECK,
            )
        ]
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: triggered,
            cancel_schedule=lambda schedule_id: None,
        )

        await dispatcher.tick(datetime(2026, 7, 29, 15, 0))

        types = [message["type"] for message in connection.sent]
        assert types == ["system.refs.check"]

    asyncio.run(scenario())


def test_handle_refs_check_reply_calendar_exists_sends_reminder() -> None:
    """收到"日历还在"的回复后,推 reminder.control + 清理指令。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        cancelled: list[str] = []
        triggered = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.NEEDS_REFS_CHECK,
            )
        ]
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: triggered,
            cancel_schedule=cancelled.append,
        )
        await dispatcher.tick(datetime(2026, 7, 29, 15, 0))
        connection.sent.clear()

        await dispatcher.handle_refs_check_reply("schedule_1", calendar_exists=True)

        types = [message["type"] for message in connection.sent]
        assert types == ["reminder.control", "system.schedule.delete"]
        assert cancelled == []

    asyncio.run(scenario())


def test_handle_refs_check_reply_calendar_missing_cancels() -> None:
    """收到"日历不在了"的回复后,取消日程,不推提醒。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        cancelled: list[str] = []
        triggered = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.NEEDS_REFS_CHECK,
            )
        ]
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: triggered,
            cancel_schedule=cancelled.append,
        )
        await dispatcher.tick(datetime(2026, 7, 29, 15, 0))
        connection.sent.clear()

        await dispatcher.handle_refs_check_reply("schedule_1", calendar_exists=False)

        assert connection.sent == []
        assert cancelled == ["schedule_1"]

    asyncio.run(scenario())


def test_handle_refs_check_reply_for_unknown_schedule_is_noop() -> None:
    """迟到或重复的回复(不在待回复登记表里)直接丢弃,不做任何处理。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        cancelled: list[str] = []
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=lambda now: [],
            cancel_schedule=cancelled.append,
        )

        await dispatcher.handle_refs_check_reply("schedule_unknown", calendar_exists=False)

        assert connection.sent == []
        assert cancelled == []

    asyncio.run(scenario())


def test_timeout_sweep_treats_stale_pending_as_calendar_exists() -> None:
    """超过超时阈值还没收到回复的,按"日历还在"处理,继续推提醒。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        first_tick_batch = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.NEEDS_REFS_CHECK,
            )
        ]
        batches: list[list[TriggeredSchedule]] = [first_tick_batch, []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        sent_at = datetime(2026, 7, 29, 15, 0)
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=run_tick,
            cancel_schedule=lambda schedule_id: None,
            timeout_seconds=30.0,
        )
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=31))

        types = [message["type"] for message in connection.sent]
        assert types == ["reminder.control", "system.schedule.delete"]

    asyncio.run(scenario())


def test_within_timeout_window_does_not_resolve_yet() -> None:
    """还没超过超时阈值时,待回复的日程不会被提前处理。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        first_tick_batch = [
            TriggeredSchedule(
                schedule_id="schedule_1",
                user_id="user_1",
                system_schedule_ref_id="system_schedule_1",
                next_step=NextStep.NEEDS_REFS_CHECK,
            )
        ]
        batches: list[list[TriggeredSchedule]] = [first_tick_batch, []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        sent_at = datetime(2026, 7, 29, 15, 0)
        dispatcher = TimeWindowDispatcher(
            connections,
            run_tick=run_tick,
            cancel_schedule=lambda schedule_id: None,
            timeout_seconds=30.0,
        )
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.tick(sent_at + timedelta(seconds=10))

        assert connection.sent == []

    asyncio.run(scenario())
