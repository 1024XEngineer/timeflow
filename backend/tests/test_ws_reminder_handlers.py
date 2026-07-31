"""提醒确认消息处理器的单元测试。"""

import asyncio

from timeflow.infrastructure.websocket.handlers.reminders import ReminderWebSocketHandlers


class _StubDispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def handle_ack(self, schedule_id: str, device_id: str) -> None:
        self.calls.append((schedule_id, device_id))


def test_reminder_control_ack_forwards_schedule_id_and_device_id() -> None:
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


def test_audio_ack_is_accepted_without_an_extra_response() -> None:
    handlers = ReminderWebSocketHandlers(_StubDispatcher())

    response = asyncio.run(
        handlers.handle_audio_ack(
            {
                "type": "reminder.audio.ack",
                "schedule_id": "schedule_001",
                "stream_id": "stream_audio_001",
                "ok": True,
            },
            "device_1",
        )
    )

    assert response is None


def test_invalid_audio_ack_returns_protocol_error() -> None:
    handlers = ReminderWebSocketHandlers(_StubDispatcher())

    response = asyncio.run(
        handlers.handle_audio_ack(
            {"type": "reminder.audio.ack", "ok": True},
            "device_1",
        )
    )

    assert response is not None
    assert response["type"] == "protocol.error"
    assert response["error"]["code"] == "VALIDATION_ERROR"
