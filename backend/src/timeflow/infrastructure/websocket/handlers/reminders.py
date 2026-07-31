"""WebSocket handlers for reminder acknowledgements."""

from __future__ import annotations

import logging
from typing import Any, Protocol

from pydantic import ValidationError

from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.reminder import ReminderAudioAck, ReminderControlAck

logger = logging.getLogger(__name__)


class _AckReceiver(Protocol):
    async def handle_ack(self, schedule_id: str, device_id: str) -> None: ...


class ReminderWebSocketHandlers:
    """Adapt reminder WS acknowledgements to reminder services."""

    def __init__(self, dispatcher: _AckReceiver) -> None:
        self._dispatcher = dispatcher

    async def handle_control_ack(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> None:
        """Handle `reminder.control.ack` and clear a pending reminder when successful."""
        ack = ReminderControlAck.model_validate(raw_message)
        if not ack.ok:
            return None
        await self._dispatcher.handle_ack(ack.schedule_id, device_id)
        return None

    async def handle_audio_ack(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any] | None:
        """Accept one reminder audio receive or playback result."""
        try:
            ack = ReminderAudioAck.model_validate(raw_message)
        except ValidationError as exc:
            return build_error_envelope(
                "protocol.error",
                None,
                "VALIDATION_ERROR",
                "提醒音频确认消息不合法",
                {"errors": exc.errors(include_url=False)},
            )

        if not ack.ok:
            logger.warning(
                "Reminder audio delivery failed",
                extra={
                    "device_id": device_id,
                    "schedule_id": ack.schedule_id,
                    "stream_id": ack.stream_id,
                    "error": ack.error.model_dump() if ack.error is not None else None,
                },
            )
        return None


__all__ = ["ReminderWebSocketHandlers"]
