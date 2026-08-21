"""Raw WebSocket adapter for Aliyun Qwen3-ASR realtime transcription."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Mapping
from enum import Enum
from typing import Protocol, TypeAlias
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from websockets.asyncio.client import connect

from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.conversation.asr import (
    AsrConnectionError,
    AsrError,
    AsrEvent,
    AsrPort,
    AsrProtocolError,
    AsrTranscriptionError,
    SpeechStarted,
    SpeechStopped,
    TranscriptCompleted,
    TranscriptPreview,
)


class WebSocketConnection(Protocol):
    async def send(self, message: str) -> None:
        """Send one JSON text frame."""

    async def recv(self) -> str | bytes:
        """Receive one provider frame."""

    async def close(self, code: int = 1000, reason: str = "") -> None:
        """Close the provider connection."""


Connector: TypeAlias = Callable[
    [str, Mapping[str, str], float],
    Awaitable[WebSocketConnection],
]


class ControlEvent(Enum):
    """Provider lifecycle events consumed by the adapter."""

    SESSION_CREATED = "session.created"
    SESSION_UPDATED = "session.updated"
    SESSION_FINISHED = "session.finished"


ParsedEvent: TypeAlias = AsrEvent | ControlEvent | None


def _new_event_id() -> str:
    return f"event_{uuid4().hex}"


def build_qwen_url(base_url: str, model: str) -> str:
    """Return the provider URL with exactly one model query parameter."""
    parts = urlsplit(base_url)
    query = [(key, value) for key, value in parse_qsl(parts.query) if key != "model"]
    query.append(("model", model))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def build_session_update(
    language: str,
    threshold: float,
    silence_ms: int,
) -> dict[str, object]:
    """Build the documented server-VAD session.update event."""
    return {
        "event_id": _new_event_id(),
        "type": "session.update",
        "session": {
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "input_audio_transcription": {"language": language},
            "turn_detection": {
                "type": "server_vad",
                "threshold": threshold,
                "silence_duration_ms": silence_ms,
            },
        },
    }


def build_audio_append(audio: bytes) -> dict[str, str]:
    """Build one documented Base64 audio append event."""
    return {
        "event_id": _new_event_id(),
        "type": "input_audio_buffer.append",
        "audio": base64.b64encode(audio).decode("ascii"),
    }


def build_session_finish() -> dict[str, str]:
    """Build the documented session.finish event."""
    return {"event_id": _new_event_id(), "type": "session.finish"}


def _string_field(message: Mapping[str, object], name: str) -> str:
    value = message.get(name)
    if not isinstance(value, str):
        raise AsrProtocolError(f"ASR event field {name!r} must be a string")
    return value


def _error_field(message: Mapping[str, object]) -> Mapping[str, object]:
    value = message.get("error")
    if not isinstance(value, Mapping):
        raise AsrProtocolError("ASR error event must contain an error object")
    return value


def _error_message(error: Mapping[str, object], fallback: str) -> str:
    message = error.get("message")
    return message if isinstance(message, str) else fallback


def parse_server_event(message: Mapping[str, object]) -> ParsedEvent:
    """Map documented provider events to public events or private controls."""
    event_type = message.get("type")
    if not isinstance(event_type, str):
        raise AsrProtocolError("ASR event type must be a string")

    if event_type == ControlEvent.SESSION_CREATED.value:
        return ControlEvent.SESSION_CREATED
    if event_type == ControlEvent.SESSION_UPDATED.value:
        return ControlEvent.SESSION_UPDATED
    if event_type == ControlEvent.SESSION_FINISHED.value:
        return ControlEvent.SESSION_FINISHED

    if event_type == "input_audio_buffer.speech_started":
        return SpeechStarted()

    if event_type == "input_audio_buffer.speech_stopped":
        return SpeechStopped()

    if event_type == "conversation.item.input_audio_transcription.text":
        confirmed = _string_field(message, "text")
        provisional = _string_field(message, "stash")
        return TranscriptPreview(text=confirmed + provisional)

    if event_type == "conversation.item.input_audio_transcription.completed":
        transcript = _string_field(message, "transcript")
        if not transcript.strip():
            return None
        return TranscriptCompleted(text=transcript)

    if event_type == "conversation.item.input_audio_transcription.failed":
        error = _error_field(message)
        raise AsrTranscriptionError(_error_message(error, "ASR transcription failed"))

    if event_type == "error":
        error = _error_field(message)
        raise AsrProtocolError(_error_message(error, "ASR provider rejected the request"))

    return None


async def _default_connector(
    url: str,
    headers: Mapping[str, str],
    timeout: float,
) -> WebSocketConnection:
    """Open a provider connection using the websockets asyncio client."""
    return await connect(
        url,
        additional_headers=dict(headers),
        open_timeout=timeout,
        # The server-VAD turn detector does not acknowledge a close frame until
        # its idle timeout (~10s) expires. We already have the final transcript by
        # then, so cap the closing handshake instead of blocking on it.
        close_timeout=0.2,
    )


class QwenRealtimeAsr(AsrPort):
    """Stream PCM audio to Qwen3-ASR and yield realtime transcript events."""

    def __init__(self, settings: Settings, connector: Connector | None = None) -> None:
        self._settings = settings
        self._connector = connector or _default_connector

    def stream(self, audio_chunks: AsyncIterable[bytes]) -> AsyncIterator[AsrEvent]:
        return self._stream(audio_chunks)

    async def _stream(
        self,
        audio_chunks: AsyncIterable[bytes],
    ) -> AsyncIterator[AsrEvent]:
        self._validate_settings()
        websocket: WebSocketConnection | None = None
        sender: asyncio.Task[None] | None = None
        receive_task: asyncio.Task[str | bytes] | None = None

        try:
            websocket = await self._connect()
            await self._expect_control(websocket, ControlEvent.SESSION_CREATED)
            await websocket.send(
                json.dumps(
                    build_session_update(
                        self._settings.aliyun_asr_language,
                        self._settings.aliyun_asr_vad_threshold,
                        self._settings.aliyun_asr_vad_silence_duration_ms,
                    )
                )
            )
            await self._expect_control(websocket, ControlEvent.SESSION_UPDATED)

            sender = asyncio.create_task(self._send_audio(websocket, audio_chunks))
            session_finished = False
            while not session_finished:
                receive_task = asyncio.create_task(websocket.recv())
                done, _ = await asyncio.wait(
                    {receive_task, sender},
                    return_when=asyncio.FIRST_COMPLETED,
                )

                if sender in done:
                    sender_exception = sender.exception()
                    if sender_exception is not None:
                        raise sender_exception
                    try:
                        raw_message = await asyncio.wait_for(
                            receive_task,
                            timeout=self._settings.aliyun_asr_finish_timeout_seconds,
                        )
                    except TimeoutError as exc:
                        receive_task.cancel()
                        await asyncio.gather(receive_task, return_exceptions=True)
                        raise AsrConnectionError(
                            "Timed out waiting for ASR session.finished"
                        ) from exc
                else:
                    raw_message = await receive_task

                parsed = self._parse_raw_message(raw_message)
                if parsed is ControlEvent.SESSION_FINISHED:
                    session_finished = True
                elif isinstance(parsed, TranscriptCompleted):
                    yield parsed
                    if sender.done():
                        # The audio source is exhausted (session.finish has been sent),
                        # so this completed transcript is the final recognition result.
                        # Stop here instead of waiting for session.finished, which the
                        # server-VAD turn detector delays by its idle timeout (~10s).
                        break
                elif isinstance(parsed, (TranscriptPreview, SpeechStarted, SpeechStopped)):
                    yield parsed

        except AsrError:
            raise
        except asyncio.CancelledError:
            raise
        except TimeoutError as exc:
            raise AsrConnectionError("Timed out during ASR WebSocket setup") from exc
        except Exception as exc:
            raise AsrConnectionError("ASR WebSocket connection failed") from exc
        finally:
            for task in (receive_task, sender):
                if task is None:
                    continue
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if websocket is not None:
                await websocket.close()

    async def _connect(self) -> WebSocketConnection:
        try:
            return await asyncio.wait_for(
                self._connector(
                    build_qwen_url(
                        self._settings.aliyun_asr_ws_url,
                        self._settings.aliyun_asr_model,
                    ),
                    {"Authorization": f"Bearer {self._settings.aliyun_asr_api_key}"},
                    self._settings.aliyun_asr_connect_timeout_seconds,
                ),
                timeout=self._settings.aliyun_asr_connect_timeout_seconds,
            )
        except TimeoutError as exc:
            raise AsrConnectionError("Timed out connecting to ASR provider") from exc
        except AsrError:
            raise
        except Exception as exc:
            raise AsrConnectionError("Failed to connect to ASR provider") from exc

    def _validate_settings(self) -> None:
        if not self._settings.aliyun_asr_ws_url:
            raise AsrConnectionError("ASR WebSocket URL is not configured")
        if not self._settings.aliyun_asr_api_key:
            raise AsrConnectionError("ASR API key is not configured")
        if not self._settings.aliyun_asr_model:
            raise AsrConnectionError("ASR model is not configured")

    async def _expect_control(
        self,
        websocket: WebSocketConnection,
        expected: ControlEvent,
    ) -> None:
        try:
            raw_message = await asyncio.wait_for(
                websocket.recv(),
                timeout=self._settings.aliyun_asr_connect_timeout_seconds,
            )
        except TimeoutError as exc:
            raise AsrConnectionError(f"Timed out waiting for {expected.value}") from exc
        except Exception as exc:
            raise AsrConnectionError("ASR provider closed during session setup") from exc

        parsed = self._parse_raw_message(raw_message)
        if parsed is not expected:
            raise AsrProtocolError(
                f"Expected ASR event {expected.value}, received {self._event_name(parsed)}"
            )

    @staticmethod
    def _event_name(event: ParsedEvent) -> str:
        if isinstance(event, ControlEvent):
            return event.value
        if event is None:
            return "unknown"
        return type(event).__name__

    @staticmethod
    def _parse_raw_message(raw_message: str | bytes) -> ParsedEvent:
        if isinstance(raw_message, bytes):
            raise AsrProtocolError("ASR provider returned a binary frame")
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError as exc:
            raise AsrProtocolError("ASR provider returned invalid JSON") from exc
        if not isinstance(message, Mapping):
            raise AsrProtocolError("ASR provider event must be a JSON object")
        return parse_server_event(message)

    @staticmethod
    async def _send_audio(
        websocket: WebSocketConnection,
        audio_chunks: AsyncIterable[bytes],
    ) -> None:
        async for audio in audio_chunks:
            if audio:
                await websocket.send(json.dumps(build_audio_append(audio)))
        await websocket.send(json.dumps(build_session_finish()))


__all__ = [
    "Connector",
    "ControlEvent",
    "QwenRealtimeAsr",
    "WebSocketConnection",
    "build_audio_append",
    "build_qwen_url",
    "build_session_finish",
    "build_session_update",
    "parse_server_event",
]
