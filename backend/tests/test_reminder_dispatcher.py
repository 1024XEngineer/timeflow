"""ReminderDispatcher 的单元测试。"""

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.workers.reminder_dispatcher import ReminderDispatcher, _PendingAck


class _FakeConnection:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


class _BlockingConnection:
    """发送时卡在 `gate` 上,用来模拟 send_json 的 await 期间真的有别的协程在跑。"""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.gate = asyncio.Event()

    async def send_json(self, data: dict[str, Any]) -> None:
        await self.gate.wait()
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

        await dispatcher.handle_ack("schedule_1", "user_1")
        await dispatcher.tick(sent_at + timedelta(seconds=31))

        assert connection.sent == []

    asyncio.run(scenario())


def test_valid_ack_marks_schedule_done() -> None:
    """ack 通过设备校验后,把日程置为 done,结束后续监听(架构设计.md §8.4)。"""

    async def scenario() -> None:
        connections, _ = _connections_with("user_1")
        done_calls: list[str] = []

        def mark_done(schedule_id: str, updated_at: datetime) -> bool:
            del updated_at
            done_calls.append(schedule_id)
            return True

        dispatcher = ReminderDispatcher(
            connections, run_tick=lambda now: [_triggered()], mark_done=mark_done
        )
        await dispatcher.tick(datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

        await dispatcher.handle_ack("schedule_1", "user_1")

        assert done_calls == ["schedule_1"]

    asyncio.run(scenario())


def test_ack_from_wrong_device_does_not_mark_done() -> None:
    """伪造的 ack 既不能清除待确认状态,也不能把别人的日程标记成已完成。"""

    async def scenario() -> None:
        connections, _ = _connections_with("user_1")
        done_calls: list[str] = []

        def mark_done(schedule_id: str, updated_at: datetime) -> bool:
            del updated_at
            done_calls.append(schedule_id)
            return True

        dispatcher = ReminderDispatcher(
            connections, run_tick=lambda now: [_triggered()], mark_done=mark_done
        )
        await dispatcher.tick(datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

        await dispatcher.handle_ack("schedule_1", "someone_elses_device")

        assert done_calls == []

    asyncio.run(scenario())


def test_mark_done_failure_keeps_pending_for_retry() -> None:
    """状态写入失败时不能把异常抛回 WS 消息循环,而且要保留待确认登记——
    否则触发时间戳已写死、两条候选查询都不会再选中它,日程会永远停在 scheduled。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        def mark_done(schedule_id: str, updated_at: datetime) -> bool:
            raise RuntimeError("db down")

        dispatcher = ReminderDispatcher(
            connections, run_tick=run_tick, ack_timeout_seconds=30.0, mark_done=mark_done
        )
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.handle_ack("schedule_1", "user_1")  # 不应该抛出

        assert "schedule_1" in dispatcher._pending, "写失败后应保留 pending 以便重试"
        await dispatcher.tick(sent_at + timedelta(seconds=31))
        assert len(connection.sent) == 1, "保留的 pending 应该走既有的超时重发路径"

    asyncio.run(scenario())


def test_mark_done_returning_false_is_terminal() -> None:
    """返回 False(日程已删除/已是 done)属于终态,不该留着反复重试。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        def mark_done(schedule_id: str, updated_at: datetime) -> bool:
            return False  # 没有匹配的行

        dispatcher = ReminderDispatcher(
            connections, run_tick=run_tick, ack_timeout_seconds=30.0, mark_done=mark_done
        )
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.handle_ack("schedule_1", "user_1")

        assert "schedule_1" not in dispatcher._pending
        await dispatcher.tick(sent_at + timedelta(seconds=31))
        assert connection.sent == [], "终态不应该重发"

    asyncio.run(scenario())


def test_handle_ack_for_unknown_schedule_is_noop() -> None:
    """从未登记过的 schedule_id 收到 ack(或者已经被超时清理过),直接丢弃,不报错。"""

    async def scenario() -> None:
        connections, _ = _connections_with("user_1")
        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [])

        await dispatcher.handle_ack("schedule_unknown", "user_1")

    asyncio.run(scenario())


def test_handle_ack_from_wrong_device_is_ignored() -> None:
    """ack 必须来自当初收到这条提醒的设备;别的设备猜到 schedule_id 也不能清除待确认状态。"""

    async def scenario() -> None:
        connections, connection = _connections_with("user_1")
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, ack_timeout_seconds=30.0)
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        await dispatcher.tick(sent_at)
        connection.sent.clear()

        await dispatcher.handle_ack("schedule_1", "someone_elses_device")
        await dispatcher.tick(sent_at + timedelta(seconds=31))

        assert len(connection.sent) == 1  # 伪造的 ack 没有生效,超时后依然正常重发

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


def test_run_forever_survives_tick_exception() -> None:
    """单轮 tick 抛异常(比如数据库临时故障)不能让轮询永久停下,下一轮应该正常继续。"""

    async def scenario() -> None:
        connections = ConnectionManager()
        calls: list[int] = []

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("boom")
            return []

        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, poll_interval_seconds=0.01)
        task = asyncio.create_task(dispatcher.run_forever())
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        assert len(calls) >= 2

    asyncio.run(scenario())


def test_ack_arriving_during_resend_is_not_dropped() -> None:
    """超时重发的 send_json 还在 await 时,如果这条日程真正的 ack 恰好到达,
    不应该被丢弃,重发完成后也不应该又把它重新登记成待确认。"""

    async def scenario() -> None:
        connections = ConnectionManager()
        connections.register("user_1", _FakeConnection())
        batches: list[list[TriggeredSchedule]] = [[_triggered()], []]

        def run_tick(now: datetime) -> list[TriggeredSchedule]:
            return batches.pop(0)

        dispatcher = ReminderDispatcher(connections, run_tick=run_tick, ack_timeout_seconds=30.0)
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        await dispatcher.tick(sent_at)  # attempt 1,登记进 _pending

        blocking_connection = _BlockingConnection()
        connections.register("user_1", blocking_connection)  # 换成会卡住的连接,模拟重发耗时

        sweep_task = asyncio.create_task(dispatcher.tick(sent_at + timedelta(seconds=31)))
        await asyncio.sleep(0)  # 让出控制权,使 tick 跑到卡在 send_json 里的地方(重发进行中)

        await dispatcher.handle_ack("schedule_1", "user_1")  # 真实 ack 恰好在这个窗口到达

        blocking_connection.gate.set()
        await sweep_task

        assert "schedule_1" not in dispatcher._pending

    asyncio.run(scenario())


def test_sweep_does_not_crash_when_ack_removes_other_expired_entry_concurrently() -> None:
    """超时扫描处理一条(还在 await 发送)时,如果 handle_ack 并发把队列里另一条也
    清除了,不应该抛 KeyError,应该跳过继续处理。"""

    async def scenario() -> None:
        connections = ConnectionManager()
        blocking_connection = _BlockingConnection()
        connections.register("user_1", blocking_connection)
        connections.register("user_2", _FakeConnection())

        dispatcher = ReminderDispatcher(connections, run_tick=lambda now: [], ack_timeout_seconds=30.0)
        sent_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
        dispatcher._pending["schedule_1"] = _PendingAck(
            schedule=_triggered(schedule_id="schedule_1", user_id="user_1"),
            sent_at=sent_at,
            attempt=1,
        )
        dispatcher._pending["schedule_2"] = _PendingAck(
            schedule=_triggered(schedule_id="schedule_2", user_id="user_2"),
            sent_at=sent_at,
            attempt=1,
        )

        sweep_task = asyncio.create_task(
            dispatcher._sweep_ack_timeouts(sent_at + timedelta(seconds=31))
        )
        await asyncio.sleep(0)  # 让 sweep 处理 schedule_1,卡在它的 send_json 里
        await dispatcher.handle_ack("schedule_2", "user_2")  # 并发把 schedule_2 也清掉

        blocking_connection.gate.set()  # 放行 schedule_1 的发送,让 sweep 继续
        await sweep_task  # 不应该抛 KeyError

        assert "schedule_2" not in dispatcher._pending

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
