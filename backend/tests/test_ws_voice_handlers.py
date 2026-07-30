"""Tests for WebSocket voice stream lifecycle handlers."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable
from dataclasses import dataclass

from timeflow.business.voice import (
    ScheduleDraft,
    ScheduleParseResult,
    SpeechRecognitionConfig,
    SpeechRecognitionResult,
    VoiceScheduleParsingService,
)
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.handlers.voice import VoiceWebSocketHandlers


@dataclass
class FakeSpeechClient:
    text: str = "明天下午三点在陆家嘴开会"
    should_fail: bool = False

    def __post_init__(self) -> None:
        self.chunks: list[bytes] = []
        self.config: SpeechRecognitionConfig | None = None

    async def recognize(
        self,
        audio_chunks: AsyncIterable[bytes],
        config: SpeechRecognitionConfig | None = None,
    ) -> SpeechRecognitionResult:
        self.config = config
        async for chunk in audio_chunks:
            self.chunks.append(chunk)
        if self.should_fail:
            raise RuntimeError("ASR unavailable")
        return SpeechRecognitionResult(text=self.text)


@dataclass
class FakeDraftInterpreter:
    should_fail: bool = False

    async def parse(self, asr_text: str) -> ScheduleParseResult:
        if self.should_fail:
            raise RuntimeError("LLM unavailable")
        return ScheduleParseResult(
            draft=ScheduleDraft(
                schedule_type="time",
                title="开会",
                notes=None,
                start_time="2026-07-31T15:00",
                end_time=None,
                timezone="Asia/Shanghai",
                location_name="陆家嘴",
                location_address=None,
                latitude=None,
                longitude=None,
                geofence_radius_meters=100,
                time_remind_offset_minutes=15,
                missing_fields=(),
                ambiguous_fields=(),
                needs_confirmation=True,
            ),
            raw_model_text=asr_text,
        )


class CapturingConnection:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []
        self.message_received = asyncio.Event()

    async def send_json(self, data: dict[str, object]) -> None:
        self.messages.append(data)
        self.message_received.set()


def _start_message(audio_format: str = "pcm_s16le") -> dict[str, object]:
    return {
        "type": "voice.stream.start",
        "request_id": "req_audio_001",
        "payload": {
            "audio_format": audio_format,
            "sample_rate_hz": 16000,
            "channels": 1,
        },
    }


def _handlers(
    speech_client: FakeSpeechClient | None = None,
    interpreter: FakeDraftInterpreter | None = None,
    *,
    max_duration_ms: int = 120_000,
) -> tuple[VoiceWebSocketHandlers, FakeSpeechClient, CapturingConnection]:
    speech = speech_client or FakeSpeechClient()
    service = VoiceScheduleParsingService(speech, interpreter or FakeDraftInterpreter())
    connections = ConnectionManager()
    connection = CapturingConnection()
    connections.register("device_1", connection)
    handlers = VoiceWebSocketHandlers(
        service,
        connections,
        stream_id_factory=lambda: "stream_audio_001",
        job_id_factory=lambda: "job_audio_001",
        max_duration_ms=max_duration_ms,
    )
    return handlers, speech, connection


def test_voice_stream_processes_binary_chunks_and_pushes_draft_after_end_ack() -> None:
    async def scenario() -> None:
        handlers, speech, connection = _handlers()

        started = await handlers.handle_start(_start_message(), "device_1")
        assert started["type"] == "voice.stream.started"
        assert await handlers.handle_binary(b"first", "device_1") is None
        assert await handlers.handle_binary(b"second", "device_1") is None

        ended = await handlers.handle_end(
            {
                "type": "voice.stream.end",
                "request_id": "req_audio_001",
                "payload": {"stream_id": "stream_audio_001"},
            },
            "device_1",
        )
        assert ended["type"] == "voice.stream.ended"
        assert ended["payload"]["status"] == "processing"

        await asyncio.sleep(0)
        assert connection.messages == []
        await handlers.handle_reply_sent(ended, "device_1")
        await asyncio.wait_for(connection.message_received.wait(), timeout=1)

        assert speech.chunks == [b"first", b"second"]
        assert speech.config == SpeechRecognitionConfig(
            audio_format="pcm_s16le",
            sample_rate_hz=16000,
            channels=1,
        )
        result = connection.messages[0]
        assert result["type"] == "voice.parse.result"
        assert result["status"] == "ready_for_confirmation"
        assert result["job_id"] == "job_audio_001"
        assert result["draft"]["title"] == "开会"
        await handlers.handle_disconnect("device_1")

    asyncio.run(scenario())


def test_voice_stream_rejects_unsupported_audio_format() -> None:
    async def scenario() -> None:
        handlers, _, _ = _handlers()

        response = await handlers.handle_start(_start_message("aac"), "device_1")

        assert response["type"] == "voice.stream.error"
        assert response["error"]["code"] == "UNSUPPORTED_AUDIO_FORMAT"

    asyncio.run(scenario())


def test_voice_stream_rejects_binary_frame_without_active_stream() -> None:
    async def scenario() -> None:
        handlers, _, _ = _handlers()

        response = await handlers.handle_binary(b"audio", "device_1")

        assert response is not None
        assert response["type"] == "protocol.error"
        assert response["error"]["code"] == "UNEXPECTED_BINARY_FRAME"

    asyncio.run(scenario())


def test_voice_stream_cancels_processing_when_duration_limit_is_exceeded() -> None:
    async def scenario() -> None:
        handlers, _, connection = _handlers(max_duration_ms=1)
        await handlers.handle_start(_start_message(), "device_1")

        response = await handlers.handle_binary(b"x" * 33, "device_1")

        assert response is not None
        assert response["type"] == "voice.stream.error"
        assert response["error"]["code"] == "AUDIO_STREAM_LIMIT_EXCEEDED"
        assert connection.messages == []
        await handlers.handle_disconnect("device_1")

    asyncio.run(scenario())


def test_voice_stream_maps_asr_failure_to_failed_parse_result() -> None:
    async def scenario() -> None:
        handlers, _, connection = _handlers(FakeSpeechClient(should_fail=True))
        await handlers.handle_start(_start_message(), "device_1")
        await handlers.handle_binary(b"audio", "device_1")
        ended = await handlers.handle_end(
            {
                "type": "voice.stream.end",
                "request_id": "req_audio_001",
                "payload": {"stream_id": "stream_audio_001"},
            },
            "device_1",
        )
        await handlers.handle_reply_sent(ended, "device_1")
        await asyncio.wait_for(connection.message_received.wait(), timeout=1)

        result = connection.messages[0]
        assert result["status"] == "failed"
        assert result["error"]["code"] == "VOICE_PARSE_FAILED"
        assert result["error"]["details"] == {"stage": "asr"}
        await handlers.handle_disconnect("device_1")

    asyncio.run(scenario())
