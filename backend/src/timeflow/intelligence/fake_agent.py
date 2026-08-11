"""Agent that answers every stream with the same fixed result, until a real one exists."""

import logging
from collections.abc import AsyncIterator, Callable
from typing import Any
from uuid import uuid4

from timeflow.intelligence.ports import (
    CommandResult,
    ReplyText,
    ResultSink,
    StreamInfo,
    Transcript,
)

logger = logging.getLogger(__name__)

FAKE_TRANSCRIPT = "明天下午三点在203开会"
FAKE_LANGUAGE = "zh"
FAKE_OPERATION = "create_schedule"
FAKE_STATUS = "applied"

# Each entry is everything said so far, not the newest fragment.
FAKE_REPLY_STEPS = ("好，", "好，明天下午三点", "好，明天下午三点在203，记下了")


def new_message_id() -> str:
    """Return a fresh identifier for a result the client must acknowledge."""
    return f"msg_{uuid4().hex}"


def new_reply_id() -> str:
    """Return a fresh identifier tying one reply's updates together."""
    return f"reply_{uuid4().hex}"


def fake_schedule(schedule_id: str) -> dict[str, Any]:
    """Return a persisted-looking schedule snapshot."""
    return {
        "id": schedule_id,
        "schedule_type": "time",
        "schedule_kind": "once",
        "title": "开会",
        "is_all_day": False,
        "start_time": "2026-08-07T07:00:00Z",
        "end_time": None,
        "timezone": "Asia/Shanghai",
        "recurrence_rule": None,
        "location_name": "203",
        "latitude": None,
        "longitude": None,
        "status": "active",
        "reminder_type": "before_start",
        "reminder_trigger_at": None,
        "reminder_offset_minutes": 15,
        "reminder_strength": "medium",
        "reminder_disposition_state": None,
        "revision": 1,
        "updated_at": "2026-08-07T06:45:00Z",
    }


class FakeAgent:
    """Drain a stream, then deliver one fixed successful result."""

    def __init__(
        self,
        result_sink: ResultSink,
        *,
        message_id_factory: Callable[[], str] | None = None,
        reply_id_factory: Callable[[], str] | None = None,
        schedule_id: str = "schedule_fake_001",
    ) -> None:
        """Store the sink plus the id seams."""
        self._result_sink = result_sink
        self._message_id_factory = message_id_factory or new_message_id
        self._reply_id_factory = reply_id_factory or new_reply_id
        self._schedule_id = schedule_id

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Read the audio to its end, then deliver the fixed transcript, result and reply."""
        byte_count = 0
        async for chunk in chunks:
            byte_count += len(chunk)

        logger.info(
            "audio received by agent",
            extra={"stream_id": stream.stream_id, "byte_count": byte_count},
        )

        transcript = Transcript(
            text=FAKE_TRANSCRIPT,
            language=FAKE_LANGUAGE,
            duration_ms=_duration_ms_of(byte_count),
        )
        await self._result_sink.deliver_transcript(transcript, stream)

        result = CommandResult(
            message_id=self._message_id_factory(),
            operation=FAKE_OPERATION,
            status=FAKE_STATUS,
            schedule=fake_schedule(self._schedule_id),
        )
        await self._result_sink.deliver_result(result, stream)

        reply_id = self._reply_id_factory()
        last = len(FAKE_REPLY_STEPS) - 1
        for step, speech_text in enumerate(FAKE_REPLY_STEPS):
            await self._result_sink.deliver_reply_text(
                ReplyText(reply_id=reply_id, speech_text=speech_text, done=step == last),
                stream,
            )


def _duration_ms_of(byte_count: int) -> int:
    """Convert 16 kHz mono 16-bit byte count into milliseconds."""
    bytes_per_ms = 16000 * 2 // 1000
    return byte_count // bytes_per_ms
