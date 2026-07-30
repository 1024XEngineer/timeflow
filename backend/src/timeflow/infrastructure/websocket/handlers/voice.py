"""WebSocket audio stream lifecycle and voice parsing result delivery."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from timeflow.business.voice import (
    SpeechRecognitionConfig,
    VoiceScheduleParsingService,
    VoiceScheduleProcessingError,
)
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail
from timeflow.infrastructure.websocket.messages.voice import (
    VoiceParseDraft,
    VoiceParseResult,
    VoiceStreamEnd,
    VoiceStreamEnded,
    VoiceStreamEndedPayload,
    VoiceStreamStart,
    VoiceStreamStarted,
    VoiceStreamStartedPayload,
)

SUPPORTED_AUDIO_FORMATS = ("pcm_s16le",)
SUPPORTED_SAMPLE_RATES_HZ = (16000,)
SUPPORTED_CHANNELS = (1,)
MAX_AUDIO_DURATION_MS = 120_000
AUDIO_QUEUE_MAX_CHUNKS = 32
PCM_S16LE_BYTES_PER_SAMPLE = 2

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _ActiveVoiceStream:
    request_id: str
    stream_id: str
    job_id: str
    config: SpeechRecognitionConfig
    queue: asyncio.Queue[bytes | None]
    max_audio_bytes: int
    total_audio_bytes: int = 0
    task: asyncio.Task[None] | None = None
    input_started: asyncio.Event = field(default_factory=asyncio.Event)
    result_delivery_ready: asyncio.Event = field(default_factory=asyncio.Event)


class VoiceWebSocketHandlers:
    """Adapt voice stream frames to the provider-independent business service."""

    def __init__(
        self,
        service: VoiceScheduleParsingService,
        connections: ConnectionManager,
        *,
        stream_id_factory: Callable[[], str] | None = None,
        job_id_factory: Callable[[], str] | None = None,
        max_duration_ms: int = MAX_AUDIO_DURATION_MS,
        queue_max_chunks: int = AUDIO_QUEUE_MAX_CHUNKS,
    ) -> None:
        self._service = service
        self._connections = connections
        self._stream_id_factory = stream_id_factory or self._new_stream_id
        self._job_id_factory = job_id_factory or self._new_job_id
        self._max_duration_ms = max_duration_ms
        self._queue_max_chunks = queue_max_chunks
        self._active_streams: dict[str, _ActiveVoiceStream] = {}
        self._processing_tasks: dict[str, set[asyncio.Task[None]]] = {}
        self._pending_end_acks: dict[tuple[str, str], _ActiveVoiceStream] = {}

    async def handle_start(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        """Validate and start one streaming ASR job for the connected device."""
        request_id = self._extract_request_id(raw_message)
        try:
            message = VoiceStreamStart.model_validate(raw_message)
        except ValidationError as exc:
            return self._error(
                request_id,
                "VALIDATION_ERROR",
                "音频流参数不合法",
                {"errors": exc.errors(include_url=False)},
            )

        if device_id in self._active_streams:
            active = self._active_streams[device_id]
            return self._error(
                message.request_id,
                "VOICE_STREAM_ALREADY_ACTIVE",
                "当前设备已有活动音频流",
                {"stream_id": active.stream_id},
            )

        payload = message.payload
        config_error = self._validate_audio_config(
            message.request_id,
            payload.audio_format,
            payload.sample_rate_hz,
            payload.channels,
        )
        if config_error is not None:
            return config_error

        config = SpeechRecognitionConfig(
            audio_format=payload.audio_format,
            sample_rate_hz=payload.sample_rate_hz,
            channels=payload.channels,
        )
        stream = _ActiveVoiceStream(
            request_id=message.request_id,
            stream_id=self._stream_id_factory(),
            job_id=self._job_id_factory(),
            config=config,
            queue=asyncio.Queue(maxsize=self._queue_max_chunks),
            max_audio_bytes=self._calculate_max_audio_bytes(config),
        )
        self._active_streams[device_id] = stream
        stream.task = asyncio.create_task(self._process_stream(device_id, stream))
        self._track_task(device_id, stream.task)

        return VoiceStreamStarted(
            request_id=message.request_id,
            payload=VoiceStreamStartedPayload(
                stream_id=stream.stream_id,
                job_id=stream.job_id,
            ),
        ).model_dump()

    async def handle_end(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        """Close the active audio input and let ASR and LLM finish asynchronously."""
        request_id = self._extract_request_id(raw_message)
        try:
            message = VoiceStreamEnd.model_validate(raw_message)
        except ValidationError as exc:
            return self._error(
                request_id,
                "VALIDATION_ERROR",
                "音频流结束参数不合法",
                {"errors": exc.errors(include_url=False)},
            )

        stream = self._active_streams.get(device_id)
        if stream is None:
            return self._error(
                message.request_id,
                "VOICE_STREAM_NOT_ACTIVE",
                "当前设备没有活动音频流",
            )
        if message.payload.stream_id != stream.stream_id:
            return self._error(
                message.request_id,
                "VOICE_STREAM_ID_MISMATCH",
                "音频流 ID 不匹配",
                {
                    "expected_stream_id": stream.stream_id,
                    "received_stream_id": message.payload.stream_id,
                },
            )
        if stream.total_audio_bytes == 0:
            await self._abort_stream(device_id, stream)
            return self._error(
                message.request_id,
                "EMPTY_AUDIO_STREAM",
                "音频流不包含音频数据",
            )

        self._active_streams.pop(device_id, None)
        self._pending_end_acks[(device_id, stream.stream_id)] = stream
        await stream.queue.put(None)
        return VoiceStreamEnded(
            request_id=message.request_id,
            payload=VoiceStreamEndedPayload(
                stream_id=stream.stream_id,
                job_id=stream.job_id,
                status="processing",
            ),
        ).model_dump()

    async def handle_binary(self, audio_chunk: bytes, device_id: str) -> dict[str, Any] | None:
        """Append one Binary Frame to the active stream with bounded backpressure."""
        stream = self._active_streams.get(device_id)
        if stream is None:
            return build_error_envelope(
                "protocol.error",
                None,
                "UNEXPECTED_BINARY_FRAME",
                "收到音频数据前必须先开始音频流",
            )
        if not audio_chunk:
            return self._error(
                stream.request_id,
                "EMPTY_AUDIO_CHUNK",
                "音频分片不能为空",
                {"stream_id": stream.stream_id},
            )
        if stream.total_audio_bytes + len(audio_chunk) > stream.max_audio_bytes:
            await self._abort_stream(device_id, stream)
            return self._error(
                stream.request_id,
                "AUDIO_STREAM_LIMIT_EXCEEDED",
                "音频流超过限制",
                {
                    "stream_id": stream.stream_id,
                    "max_duration_ms": self._max_duration_ms,
                },
            )

        stream.total_audio_bytes += len(audio_chunk)
        stream.input_started.set()
        await stream.queue.put(audio_chunk)
        return None

    async def handle_reply_sent(self, reply: dict[str, Any], device_id: str) -> None:
        """Release final-result delivery after the stream-ended ACK is on the wire."""
        if reply.get("type") != "voice.stream.ended":
            return
        payload = reply.get("payload")
        if not isinstance(payload, dict):
            return
        stream_id = payload.get("stream_id")
        if not isinstance(stream_id, str):
            return
        stream = self._pending_end_acks.pop((device_id, stream_id), None)
        if stream is not None:
            stream.result_delivery_ready.set()

    async def handle_disconnect(self, device_id: str) -> None:
        """Cancel active and processing work when the owning WebSocket disconnects."""
        active = self._active_streams.pop(device_id, None)
        pending_keys = [key for key in self._pending_end_acks if key[0] == device_id]
        for key in pending_keys:
            self._pending_end_acks.pop(key, None)
        tasks = set(self._processing_tasks.pop(device_id, set()))
        if active is not None and active.task is not None:
            tasks.add(active.task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _process_stream(self, device_id: str, stream: _ActiveVoiceStream) -> None:
        try:
            await stream.input_started.wait()
            result = await self._service.parse_audio(
                self._audio_chunks(stream.queue),
                stream.config,
            )
            draft = result.parsed.draft
            message = VoiceParseResult(
                request_id=stream.request_id,
                job_id=stream.job_id,
                status="ready_for_confirmation",
                draft=VoiceParseDraft(
                    schedule_type=draft.schedule_type,
                    title=draft.title,
                    start_time=draft.start_time,
                    end_time=draft.end_time,
                    timezone=draft.timezone,
                    location_name=draft.location_name,
                    geofence_radius_meters=draft.geofence_radius_meters,
                    time_remind_offset_minutes=draft.time_remind_offset_minutes,
                ),
                missing_fields=list(draft.missing_fields),
                ambiguous_fields=list(draft.ambiguous_fields),
                needs_confirmation=draft.needs_confirmation,
            ).model_dump()
        except VoiceScheduleProcessingError as exc:
            logger.exception(
                "Voice schedule processing failed",
                extra={"device_id": device_id, "job_id": stream.job_id, "stage": exc.stage},
            )
            message = self._parse_failure(stream, exc.stage)
        except Exception:
            logger.exception(
                "Unexpected voice stream processing failure",
                extra={"device_id": device_id, "job_id": stream.job_id},
            )
            message = self._parse_failure(stream, "unknown")

        await stream.result_delivery_ready.wait()
        await self._connections.send(device_id, message)

    @staticmethod
    async def _audio_chunks(queue: asyncio.Queue[bytes | None]) -> AsyncIterator[bytes]:
        while True:
            chunk = await queue.get()
            try:
                if chunk is None:
                    return
                yield chunk
            finally:
                queue.task_done()

    async def _abort_stream(self, device_id: str, stream: _ActiveVoiceStream) -> None:
        if self._active_streams.get(device_id) is stream:
            self._active_streams.pop(device_id, None)
        self._pending_end_acks.pop((device_id, stream.stream_id), None)
        if stream.task is not None and not stream.task.done():
            stream.task.cancel()
            with suppress(asyncio.CancelledError):
                await stream.task

    def _track_task(self, device_id: str, task: asyncio.Task[None]) -> None:
        tasks = self._processing_tasks.setdefault(device_id, set())
        tasks.add(task)

        def discard(completed: asyncio.Task[None]) -> None:
            device_tasks = self._processing_tasks.get(device_id)
            if device_tasks is None:
                return
            device_tasks.discard(completed)
            if not device_tasks:
                self._processing_tasks.pop(device_id, None)

        task.add_done_callback(discard)

    def _calculate_max_audio_bytes(self, config: SpeechRecognitionConfig) -> int:
        duration_seconds = self._max_duration_ms / 1000
        return int(
            config.sample_rate_hz * config.channels * PCM_S16LE_BYTES_PER_SAMPLE * duration_seconds
        )

    @staticmethod
    def _validate_audio_config(
        request_id: str,
        audio_format: str,
        sample_rate_hz: int,
        channels: int,
    ) -> dict[str, Any] | None:
        if audio_format not in SUPPORTED_AUDIO_FORMATS:
            return VoiceWebSocketHandlers._error(
                request_id,
                "UNSUPPORTED_AUDIO_FORMAT",
                "音频格式不支持",
                {
                    "audio_format": audio_format,
                    "supported_formats": list(SUPPORTED_AUDIO_FORMATS),
                },
            )
        if sample_rate_hz not in SUPPORTED_SAMPLE_RATES_HZ or channels not in SUPPORTED_CHANNELS:
            return VoiceWebSocketHandlers._error(
                request_id,
                "UNSUPPORTED_AUDIO_CONFIG",
                "音频采样配置不支持",
                {
                    "sample_rate_hz": sample_rate_hz,
                    "channels": channels,
                    "supported_sample_rates_hz": list(SUPPORTED_SAMPLE_RATES_HZ),
                    "supported_channels": list(SUPPORTED_CHANNELS),
                },
            )
        return None

    @staticmethod
    def _parse_failure(stream: _ActiveVoiceStream, stage: str) -> dict[str, Any]:
        return VoiceParseResult(
            request_id=stream.request_id,
            job_id=stream.job_id,
            status="failed",
            error=ErrorDetail(
                code="VOICE_PARSE_FAILED",
                message="语音解析失败，请重新录音或手动创建",
                details={"stage": stage},
            ),
        ).model_dump()

    @staticmethod
    def _extract_request_id(raw_message: dict[str, Any]) -> str | None:
        value = raw_message.get("request_id")
        return value if isinstance(value, str) else None

    @staticmethod
    def _error(
        request_id: str | None,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return build_error_envelope(
            "voice.stream.error",
            request_id,
            code,
            message,
            details,
        )

    @staticmethod
    def _new_stream_id() -> str:
        return f"stream_{uuid4().hex}"

    @staticmethod
    def _new_job_id() -> str:
        return f"job_{uuid4().hex}"


__all__ = ["VoiceWebSocketHandlers"]
