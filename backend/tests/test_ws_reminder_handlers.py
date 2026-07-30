"""`ReminderWebSocketHandlers` 的单元测试:只做解析转发,没有判断逻辑。"""

import asyncio

from timeflow.infrastructure.websocket.handlers.reminders import ReminderWebSocketHandlers


class _StubDispatcher:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def handle_ack(self, schedule_id: str) -> None:
        self.calls.append(schedule_id)


def test_reminder_control_ack_forwards_schedule_id() -> None:
    """`reminder.control.ack` 原样把 schedule_id 转发给 dispatcher。"""

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
        assert dispatcher.calls == ["schedule_1"]

    asyncio.run(scenario())
