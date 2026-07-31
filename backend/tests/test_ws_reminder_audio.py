"""Tests for server-initiated reminder audio delivery."""

import asyncio
from typing import Any

from timeflow.business.reminders import ReminderAudio
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.reminder_audio import ReminderAudioSender


class FakeConnection:
    def __init__(self) -> None:
        self.frames: list[tuple[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.frames.append(("json", data))

    async def send_bytes(self, data: bytes) -> None:
        self.frames.append(("bytes", data))


class FakeStorage:
    async def replace(self, schedule_id: str, audio: ReminderAudio) -> None:
        del schedule_id, audio

    async def read(self, schedule_id: str) -> ReminderAudio | None:
        if schedule_id != "schedule_001":
            return None
        return ReminderAudio(data=b"audio-data", audio_format="wav")

    async def delete(self, schedule_id: str) -> None:
        del schedule_id


def test_sender_delivers_control_then_audio_frames() -> None:
    async def scenario() -> None:
        connections = ConnectionManager()
        connection = FakeConnection()
        connections.register("device_1", connection)
        sender = ReminderAudioSender(
            connections,
            FakeStorage(),
            stream_id_factory=lambda: "stream_audio_001",
        )

        delivered = await sender.send_reminder(
            "device_1",
            "schedule_001",
            reason="time_window_reached",
        )

        assert delivered is True
        assert connection.frames == [
            (
                "json",
                {
                    "type": "reminder.control",
                    "schedule_id": "schedule_001",
                    "reason": "time_window_reached",
                    "action": "show",
                },
            ),
            (
                "json",
                {
                    "type": "reminder.audio.start",
                    "schedule_id": "schedule_001",
                    "stream_id": "stream_audio_001",
                    "audio_format": "wav",
                },
            ),
            ("bytes", b"audio-data"),
            (
                "json",
                {
                    "type": "reminder.audio.end",
                    "schedule_id": "schedule_001",
                    "stream_id": "stream_audio_001",
                },
            ),
        ]

    asyncio.run(scenario())


def test_sender_returns_false_for_offline_device() -> None:
    async def scenario() -> None:
        sender = ReminderAudioSender(ConnectionManager(), FakeStorage())

        delivered = await sender.send_reminder(
            "missing_device",
            "schedule_001",
            reason="time_window_reached",
        )

        assert delivered is False

    asyncio.run(scenario())
