"""The inbound audio stream lifecycle: start, binary frames, end, disconnect."""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from timeflow.gateway.websocket.envelope import ERROR_AUDIO_INVALID, build_error_envelope
from timeflow.gateway.websocket.messages.voice import (
    VoiceStreamEnd,
    VoiceStreamStart,
    VoiceStreamStarted,
    VoiceStreamStartedPayload,
)
from timeflow.gateway.websocket.ports import (
    AudioConfig,
    AudioSink,
    SessionContext,
    StreamContext,
)

logger = logging.getLogger(__name__)

SUPPORTED_AUDIO_FORMATS = ("pcm_s16le",)
SUPPORTED_SAMPLE_RATES_HZ = (16000,)
SUPPORTED_CHANNELS = (1,)
BYTES_PER_SAMPLE = {"pcm_s16le": 2}


@dataclass(slots=True)
class _ActiveStream:
    """Bookkeeping for one in-flight audio stream."""

    context: StreamContext
    request_id: str | None
    queue: asyncio.Queue[bytes | None]
    max_audio_bytes: int
    total_audio_bytes: int = 0
    task: asyncio.Task[None] | None = None
    input_started: asyncio.Event = field(default_factory=asyncio.Event)


def new_stream_id() -> str:
    """Return a fresh stream identifier."""
    return f"stream_{uuid4().hex}"


def new_conversation_id() -> str:
    """Return a fresh conversation identifier."""
    return f"conversation_{uuid4().hex}"


class VoiceStreamHandlers:
    """Accept audio frames for a session and forward them to the sink."""

    def __init__(
        self,
        audio_sink: AudioSink,
        *,
        max_audio_duration_ms: int = 120_000,
        queue_max_chunks: int = 32,
        stream_id_factory: Callable[[], str] | None = None,
        conversation_id_factory: Callable[[], str] | None = None,
    ) -> None:
        """Store the sink plus the audio limits and id seams."""
        self._audio_sink = audio_sink
        self._max_audio_duration_ms = max_audio_duration_ms
        self._queue_max_chunks = queue_max_chunks
        self._stream_id_factory = stream_id_factory or new_stream_id
        self._conversation_id_factory = conversation_id_factory or new_conversation_id
        self._active_streams: dict[str, _ActiveStream] = {}
        self._tasks: dict[str, set[asyncio.Task[None]]] = {}

    async def handle_start(
        self, raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Open an audio stream and allow binary frames to follow."""
        request_id = _request_id_of(raw_message)
        try:
            message = VoiceStreamStart.model_validate(raw_message)
        except ValidationError:
            return self._error(request_id, "voice.stream.start payload is invalid")

        # Safe without a lock: the receive loop is the only caller and there is no await
        # between this check and the assignment below.
        active = self._active_streams.get(session.session_id)
        if active is not None:
            return self._error(request_id, "A stream is already active for this session", active)

        payload = message.payload
        invalid = _validate_audio_config(
            payload.audio_format, payload.sample_rate_hz, payload.channels
        )
        if invalid is not None:
            return self._error(request_id, invalid)

        audio_config = AudioConfig(
            audio_format=payload.audio_format,
            sample_rate_hz=payload.sample_rate_hz,
            channels=payload.channels,
        )
        context = StreamContext(
            stream_id=self._stream_id_factory(),
            conversation_id=payload.conversation_id or self._conversation_id_factory(),
            session=session,
            audio_config=audio_config,
            request_id=request_id,
        )
        stream = _ActiveStream(
            context=context,
            request_id=request_id,
            queue=asyncio.Queue(maxsize=self._queue_max_chunks),
            max_audio_bytes=self._max_audio_bytes(audio_config),
        )
        self._active_streams[session.session_id] = stream

        stream.task = asyncio.create_task(self._drain_to_sink(stream))
        self._track_task(session.session_id, stream.task)

        reply = VoiceStreamStarted(
            request_id=message.request_id,
            payload=VoiceStreamStartedPayload(
                stream_id=context.stream_id,
                conversation_id=context.conversation_id,
            ),
        )
        return reply.model_dump()

    async def handle_end(
        self, raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Close the audio stream, signalling end of input to the sink."""
        request_id = _request_id_of(raw_message)
        try:
            message = VoiceStreamEnd.model_validate(raw_message)
        except ValidationError:
            return self._error(request_id, "voice.stream.end payload is invalid")

        stream = self._active_streams.get(session.session_id)
        if stream is None:
            return self._error(request_id, "No audio stream is active for this session")
        if message.payload.stream_id != stream.context.stream_id:
            return self._error(request_id, "stream_id does not match the active stream", stream)
        if stream.total_audio_bytes == 0:
            await self._abort(session.session_id, stream)
            return self._error(request_id, "The audio stream carried no audio", stream)

        self._active_streams.pop(session.session_id, None)
        await stream.queue.put(None)
        return None

    async def handle_binary(self, chunk: bytes, session: SessionContext) -> dict[str, Any] | None:
        """Enqueue one audio chunk, applying backpressure when the queue is full."""
        stream = self._active_streams.get(session.session_id)
        if stream is None:
            return self._error(None, "Audio frames require voice.stream.start first")
        if not chunk:
            return self._error(stream.request_id, "Audio frame is empty", stream)
        if stream.total_audio_bytes + len(chunk) > stream.max_audio_bytes:
            await self._abort(session.session_id, stream)
            return self._error(
                stream.request_id,
                f"The audio stream exceeded {self._max_audio_duration_ms} ms",
                stream,
            )

        stream.total_audio_bytes += len(chunk)
        stream.input_started.set()
        # Blocks the receive loop when the queue is full, which propagates backpressure
        # to the client over TCP rather than dropping frames.
        await stream.queue.put(chunk)
        return None

    async def handle_disconnect(self, session: SessionContext) -> None:
        """Cancel any work still running for a closed session."""
        self._active_streams.pop(session.session_id, None)
        tasks = set(self._tasks.pop(session.session_id, set()))
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _drain_to_sink(self, stream: _ActiveStream) -> None:
        """Feed queued chunks to the sink once the first frame has arrived."""
        await stream.input_started.wait()
        try:
            await self._audio_sink.consume(_chunks_of(stream.queue), stream.context)
        except Exception:
            logger.exception(
                "audio sink failed",
                extra={
                    "session_id": stream.context.session.session_id,
                    "stream_id": stream.context.stream_id,
                },
            )
            self._retire_failed_stream(stream)

    def _retire_failed_stream(self, stream: _ActiveStream) -> None:
        """Drop a stream whose consumer has died, so the session keeps working.

        Removing it alone is not enough: the receive loop may be parked on a full
        queue with nobody left to drain it, and would stay there forever. Emptying
        the queue releases it, and the next frame is refused instead of enqueued.
        """
        session_id = stream.context.session.session_id
        if self._active_streams.get(session_id) is stream:
            self._active_streams.pop(session_id, None)
        while not stream.queue.empty():
            stream.queue.get_nowait()
            stream.queue.task_done()

    async def _abort(self, session_id: str, stream: _ActiveStream) -> None:
        """Tear down a stream that violated its limits."""
        if self._active_streams.get(session_id) is stream:
            self._active_streams.pop(session_id, None)
        if stream.task is not None and not stream.task.done():
            stream.task.cancel()
            await asyncio.gather(stream.task, return_exceptions=True)

    def _track_task(self, session_id: str, task: asyncio.Task[None]) -> None:
        """Hold a reference to a task and drop it once it finishes."""
        tasks = self._tasks.setdefault(session_id, set())
        tasks.add(task)

        def discard(completed: asyncio.Task[None]) -> None:
            session_tasks = self._tasks.get(session_id)
            if session_tasks is None:
                return
            session_tasks.discard(completed)
            if not session_tasks:
                self._tasks.pop(session_id, None)

        task.add_done_callback(discard)

    def _max_audio_bytes(self, audio_config: AudioConfig) -> int:
        """Convert the duration budget into a byte budget for this format."""
        bytes_per_sample = BYTES_PER_SAMPLE[audio_config.audio_format]
        duration_seconds = self._max_audio_duration_ms / 1000
        return int(
            audio_config.sample_rate_hz
            * audio_config.channels
            * bytes_per_sample
            * duration_seconds
        )

    @staticmethod
    def _error(
        request_id: str | None, message: str, stream: "_ActiveStream | None" = None
    ) -> dict[str, Any]:
        """Build the audio error envelope, naming the conversation when one exists."""
        return build_error_envelope(
            "voice.command.error",
            request_id,
            ERROR_AUDIO_INVALID,
            message,
            conversation_id=stream.context.conversation_id if stream is not None else None,
        )


async def _chunks_of(queue: asyncio.Queue[bytes | None]) -> AsyncIterator[bytes]:
    """Yield queued chunks until the end-of-input sentinel arrives."""
    while True:
        chunk = await queue.get()
        try:
            if chunk is None:
                return
            yield chunk
        finally:
            queue.task_done()


def _request_id_of(raw_message: dict[str, Any]) -> str | None:
    """Extract request_id from a message that may not have validated."""
    request_id = raw_message.get("request_id")
    return request_id if isinstance(request_id, str) else None


def _validate_audio_config(audio_format: str, sample_rate_hz: int, channels: int) -> str | None:
    """Return a reason string when the audio config is unsupported."""
    if audio_format not in SUPPORTED_AUDIO_FORMATS:
        return f"Unsupported audio_format: {audio_format}"
    if sample_rate_hz not in SUPPORTED_SAMPLE_RATES_HZ:
        return f"Unsupported sample_rate_hz: {sample_rate_hz}"
    if channels not in SUPPORTED_CHANNELS:
        return f"Unsupported channels: {channels}"
    return None
