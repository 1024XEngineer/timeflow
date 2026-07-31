"""`ReminderWebSocketHandlers` 的单元测试:只做解析转发,没有判断逻辑。"""

import asyncio

from timeflow.infrastructure.websocket.handlers.reminders import ReminderWebSocketHandlers


class _StubDispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def handle_ack(self, schedule_id: str, device_id: str) -> None:
        self.calls.append((schedule_id, device_id))


def test_reminder_control_ack_forwards_schedule_id_and_device_id() -> None:
    """`reminder.control.ack` 在 ok=True 时把 schedule_id 和来源 device_id 转发给 dispatcher。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handlers = ReminderWebSocketHandlers(dispatcher)

        result = await handlers.handle_control_ack(
            {
                "type": "reminder.control.ack",
                "schedule_id": "schedule_1",
                "ok": True,
            },
            "device_1",
        )

        assert result is None
        assert dispatcher.calls == [("schedule_1", "device_1")]

    asyncio.run(scenario())


def test_reminder_control_ack_with_ok_false_does_not_forward() -> None:
    """`ok=False`(客户端明确表示没能展示成功)不应该转发给 dispatcher 当作已确认。"""

    async def scenario() -> None:
        dispatcher = _StubDispatcher()
        handlers = ReminderWebSocketHandlers(dispatcher)

        result = await handlers.handle_control_ack(
            {
                "type": "reminder.control.ack",
                "schedule_id": "schedule_1",
                "ok": False,
            },
            "device_1",
        )

        assert result is None
        assert dispatcher.calls == []

    asyncio.run(scenario())
