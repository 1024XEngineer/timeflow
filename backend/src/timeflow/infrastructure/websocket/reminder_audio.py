"""Server-initiated reminder control and audio delivery."""

from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

from timeflow.business.reminders import ReminderAudioStoragePort
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.messages.reminder import (
    ReminderAudioEnd,
    ReminderAudioStart,
    ReminderControl,
)


class ReminderAudioSender:
    """Send one reminder control message followed by its current audio file."""

    def __init__(
        self,
        connections: ConnectionManager,
        storage: ReminderAudioStoragePort,
        *,
        stream_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._connections = connections
        self._storage = storage
        self._stream_id_factory = stream_id_factory or self._new_stream_id

    async def send_reminder(
        self,
        device_id: str,
        schedule_id: str,
        *,
        reason: str,
        action: str = "show",
    ) -> bool:
        """Deliver reminder control and audio to one connected device."""
        control = ReminderControl(
            schedule_id=schedule_id,
            reason=reason,
            action=action,
        ).model_dump()
        audio = await self._storage.read(schedule_id)
        if audio is None:
            return False

        stream_id = self._stream_id_factory()
        start = ReminderAudioStart(
            schedule_id=schedule_id,
            stream_id=stream_id,
            audio_format=audio.audio_format,
        ).model_dump()
        end = ReminderAudioEnd(
            schedule_id=schedule_id,
            stream_id=stream_id,
        ).model_dump()
        return await self._connections.send_audio(
            device_id,
            start,
            audio.data,
            end,
            preceding_message=control,
        )

    @staticmethod
    def _new_stream_id() -> str:
        return f"stream_reminder_{uuid4().hex}"


__all__ = ["ReminderAudioSender"]
