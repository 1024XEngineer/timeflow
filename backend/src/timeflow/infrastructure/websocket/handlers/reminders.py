"""WebSocket handlers for reminder acknowledgements."""

from typing import Any, Protocol

from timeflow.infrastructure.websocket.messages.reminder import ReminderControlAck


class _AckReceiver(Protocol):
    async def handle_ack(self, schedule_id: str, device_id: str) -> None: ...


class ReminderWebSocketHandlers:
    """Adapt reminder WS messages to the dispatcher's ack-tracking calls."""

    def __init__(self, dispatcher: _AckReceiver) -> None:
        self._dispatcher = dispatcher

    async def handle_control_ack(self, raw_message: dict[str, Any], device_id: str) -> None:
        """Handle `reminder.control.ack`; only parses and forwards.

        `ok=False`(客户端明确表示没能展示成功)不清除待确认状态,交给
        dispatcher 自身的超时重试/放弃逻辑处理,而不是当作已完成。
        """
        ack = ReminderControlAck.model_validate(raw_message)
        if not ack.ok:
            return None
        await self._dispatcher.handle_ack(ack.schedule_id, device_id)
        return None


__all__ = ["ReminderWebSocketHandlers"]
