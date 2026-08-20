"""Raw WebSocket adapter for Aliyun Qwen-Audio-TTS."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, TypeAlias
from uuid import uuid4

from websockets.asyncio.client import connect

from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.speech.tts import (
    SpeechSegment,
    TtsAudioChunk,
    TtsCompleted,
    TtsConnectionError,
    TtsError,
    TtsEvent,
    TtsPort,
    TtsProtocolError,
    TtsSynthesisError,
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


class ServerEventType(Enum):
    TASK_STARTED = "task-started"
    RESULT_GENERATED = "result-generated"
    TASK_FINISHED = "task-finished"


class ResultType(Enum):
    SENTENCE_BEGIN = "sentence-begin"
    SENTENCE_SYNTHESIS = "sentence-synthesis"
    SENTENCE_END = "sentence-end"


@dataclass(frozen=True, slots=True)
class ServerEvent:
    event_type: ServerEventType
    task_id: str
    result_type: ResultType | None = None
    sentence_index: int | None = None
    original_text: str | None = None
    characters: int | None = None


def build_run_task(
    task_id: str,
    *,
    model: str,
    voice: str,
) -> dict[str, object]:
    """Build the documented Qwen-Audio-TTS run-task event."""
    return {
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": model,
            "input": {},
            "parameters": {
                "text_type": "PlainText",
                "voice": voice,
                "format": "pcm",
                "sample_rate": 24000,
                "volume": 50,
                "rate": 1.0,
                "pitch": 1.0,
                "enable_ssml": False,
            },
        },
    }


def build_continue_task(task_id: str, text: str) -> dict[str, object]:
    """Build one documented Qwen-Audio-TTS continue-task event."""
    if not text.strip():
        raise ValueError("TTS text segment must be non-empty")
    return {
        "header": {
            "action": "continue-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {"input": {"text": text}},
    }


def build_finish_task(task_id: str, *, cancel: bool = False) -> dict[str, object]:
    """Build a normal or cancelling Qwen-Audio-TTS finish-task event."""
    input_payload: dict[str, str] = {"directive": "cancel"} if cancel else {}
    return {
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {"input": input_payload},
    }


def _required_mapping(value: object, message: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TtsProtocolError(message)
    return value


def _required_string(value: object, message: str) -> str:
    if not isinstance(value, str) or not value:
        raise TtsProtocolError(message)
    return value


def _optional_non_negative_int(value: object, message: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TtsProtocolError(message)
    return value


def _usage_characters(payload: Mapping[str, object]) -> int | None:
    usage = payload.get("usage")
    if usage is None:
        return None
    usage_mapping = _required_mapping(usage, "TTS usage must be an object")
    return _optional_non_negative_int(
        usage_mapping.get("characters"),
        "TTS usage characters must be a non-negative integer",
    )


def parse_server_event(message: Mapping[str, object], expected_task_id: str) -> ServerEvent:
    """Parse one documented Qwen-Audio-TTS server event."""
    header = _required_mapping(message.get("header"), "TTS event header must be an object")
    task_id = _required_string(header.get("task_id"), "TTS event task_id must be a string")
    if task_id != expected_task_id:
        raise TtsProtocolError("TTS event task_id does not match the active task")
    event_name = _required_string(header.get("event"), "TTS event name must be a string")

    if event_name == "task-failed":
        raise TtsSynthesisError("TTS provider failed the synthesis task")

    payload = _required_mapping(message.get("payload"), "TTS event payload must be an object")
    if event_name == ServerEventType.TASK_STARTED.value:
        return ServerEvent(ServerEventType.TASK_STARTED, task_id)
    if event_name == ServerEventType.TASK_FINISHED.value:
        return ServerEvent(
            ServerEventType.TASK_FINISHED,
            task_id,
            characters=_usage_characters(payload),
        )
    if event_name != ServerEventType.RESULT_GENERATED.value:
        raise TtsProtocolError("TTS provider returned an unsupported event")

    output = _required_mapping(payload.get("output"), "TTS result output must be an object")
    result_name = _required_string(output.get("type"), "TTS result type must be a string")
    try:
        result_type = ResultType(result_name)
    except ValueError as exc:
        raise TtsProtocolError("TTS provider returned an unsupported result type") from exc
    sentence = _required_mapping(
        output.get("sentence"),
        "TTS result sentence must be an object",
    )
    sentence_index = _optional_non_negative_int(
        sentence.get("index"),
        "TTS sentence index must be a non-negative integer",
    )
    if sentence_index is None:
        raise TtsProtocolError("TTS sentence index is missing")
    original_text = output.get("original_text")
    if original_text is not None and not isinstance(original_text, str):
        raise TtsProtocolError("TTS original text must be a string")
    return ServerEvent(
        ServerEventType.RESULT_GENERATED,
        task_id,
        result_type=result_type,
        sentence_index=sentence_index,
        original_text=original_text,
        characters=_usage_characters(payload),
    )


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
        # The provider does not acknowledge a close frame until its idle timeout
        # (~10s) expires. All audio has already been delivered by then, so cap the
        # closing handshake instead of blocking the turn on it.
        close_timeout=0.2,
    )


class QwenAudioTts(TtsPort):
    """Stream approved text segments to Qwen-Audio-TTS and yield PCM chunks."""

    def __init__(self, settings: Settings, connector: Connector | None = None) -> None:
        self._settings = settings
        self._connector = connector or _default_connector

    def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
        return self._stream(segments)

    async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
        self._validate_settings()
        task_id = uuid4().hex
        websocket: WebSocketConnection | None = None
        sender: asyncio.Task[None] | None = None
        task_started = False
        task_finished = False

        try:
            websocket = await self._connect()
            await websocket.send(
                json.dumps(
                    build_run_task(
                        task_id,
                        model=self._settings.aliyun_tts_model,
                        voice=self._settings.aliyun_tts_voice,
                    )
                )
            )
            started = await self._receive_event(
                websocket,
                task_id,
                timeout=self._settings.aliyun_tts_connect_timeout_seconds,
            )
            if started.event_type is not ServerEventType.TASK_STARTED:
                raise TtsProtocolError("Expected TTS task-started event")
            task_started = True
            sender = asyncio.create_task(self._send_segments(websocket, task_id, segments))

            expect_audio = False
            characters: int | None = None
            while not task_finished:
                receive_task = asyncio.create_task(websocket.recv())
                done, _ = await asyncio.wait(
                    {receive_task, sender},
                    timeout=self._settings.aliyun_tts_task_timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    receive_task.cancel()
                    await asyncio.gather(receive_task, return_exceptions=True)
                    raise TtsConnectionError("Timed out waiting for TTS provider output")
                if sender in done:
                    sender_exception = sender.exception()
                    if sender_exception is not None:
                        receive_task.cancel()
                        await asyncio.gather(receive_task, return_exceptions=True)
                        raise sender_exception
                if receive_task not in done:
                    try:
                        raw_message = await asyncio.wait_for(
                            receive_task,
                            timeout=self._settings.aliyun_tts_task_timeout_seconds,
                        )
                    except TimeoutError as exc:
                        receive_task.cancel()
                        await asyncio.gather(receive_task, return_exceptions=True)
                        raise TtsConnectionError(
                            "Timed out waiting for TTS provider output"
                        ) from exc
                else:
                    raw_message = receive_task.result()

                if isinstance(raw_message, bytes):
                    if not expect_audio:
                        raise TtsProtocolError("TTS provider returned an unexpected binary frame")
                    if not raw_message:
                        raise TtsProtocolError("TTS provider returned an empty audio frame")
                    expect_audio = False
                    yield TtsAudioChunk(raw_message)
                    continue

                if expect_audio:
                    raise TtsProtocolError("TTS sentence-synthesis was not followed by audio")
                event = self._parse_raw_event(raw_message, task_id)
                if event.event_type is ServerEventType.RESULT_GENERATED:
                    if event.result_type is ResultType.SENTENCE_SYNTHESIS:
                        expect_audio = True
                    if event.characters is not None:
                        characters = event.characters
                    continue
                if event.event_type is ServerEventType.TASK_FINISHED:
                    if sender is not None:
                        await sender
                    task_finished = True
                    if event.characters is not None:
                        characters = event.characters

            if expect_audio:
                raise TtsProtocolError("TTS task finished before its audio frame arrived")
            yield TtsCompleted(characters)
        except asyncio.CancelledError:
            if websocket is not None and task_started and not task_finished:
                await self._try_cancel(websocket, task_id)
            raise
        except TtsError:
            raise
        except TimeoutError as exc:
            raise TtsConnectionError("Timed out during TTS WebSocket setup") from exc
        except Exception as exc:
            raise TtsConnectionError("TTS WebSocket connection failed") from exc
        finally:
            if sender is not None and not sender.done():
                sender.cancel()
            if sender is not None:
                await asyncio.gather(sender, return_exceptions=True)
            if websocket is not None:
                await websocket.close()

    async def _connect(self) -> WebSocketConnection:
        try:
            return await asyncio.wait_for(
                self._connector(
                    self._settings.aliyun_tts_ws_url,
                    {"Authorization": f"Bearer {self._settings.aliyun_tts_api_key}"},
                    self._settings.aliyun_tts_connect_timeout_seconds,
                ),
                timeout=self._settings.aliyun_tts_connect_timeout_seconds,
            )
        except TimeoutError as exc:
            raise TtsConnectionError("Timed out connecting to TTS provider") from exc
        except TtsError:
            raise
        except Exception as exc:
            raise TtsConnectionError("Failed to connect to TTS provider") from exc

    def _validate_settings(self) -> None:
        if not self._settings.aliyun_tts_ws_url:
            raise TtsConnectionError("TTS WebSocket URL is not configured")
        if not self._settings.aliyun_tts_api_key:
            raise TtsConnectionError("TTS API key is not configured")
        if not self._settings.aliyun_tts_model:
            raise TtsConnectionError("TTS model is not configured")
        if not self._settings.aliyun_tts_voice:
            raise TtsConnectionError("TTS voice is not configured")

    async def _receive_event(
        self,
        websocket: WebSocketConnection,
        task_id: str,
        *,
        timeout: float,
    ) -> ServerEvent:
        try:
            raw_message = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        except TimeoutError as exc:
            raise TtsConnectionError("Timed out waiting for TTS task-started") from exc
        except Exception as exc:
            raise TtsConnectionError("TTS provider closed during task setup") from exc
        if isinstance(raw_message, bytes):
            raise TtsProtocolError("TTS provider returned audio before task-started")
        return self._parse_raw_event(raw_message, task_id)

    @staticmethod
    def _parse_raw_event(raw_message: str, task_id: str) -> ServerEvent:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError as exc:
            raise TtsProtocolError("TTS provider returned invalid JSON") from exc
        if not isinstance(message, Mapping):
            raise TtsProtocolError("TTS provider event must be a JSON object")
        return parse_server_event(message, task_id)

    @staticmethod
    async def _send_segments(
        websocket: WebSocketConnection,
        task_id: str,
        segments: AsyncIterable[SpeechSegment],
    ) -> None:
        expected_index = 0
        total_characters = 0
        async for segment in segments:
            if segment.index != expected_index:
                raise TtsProtocolError("TTS segments must have consecutive indexes")
            if not segment.text.strip():
                raise TtsProtocolError("TTS segment text must be non-empty")
            if len(segment.text) > 20000:
                raise TtsProtocolError("TTS segment exceeds the provider text limit")
            total_characters += len(segment.text)
            if total_characters > 200000:
                raise TtsProtocolError("TTS task exceeds the provider cumulative text limit")
            await websocket.send(json.dumps(build_continue_task(task_id, segment.text)))
            expected_index += 1
        await websocket.send(json.dumps(build_finish_task(task_id)))

    @staticmethod
    async def _try_cancel(websocket: WebSocketConnection, task_id: str) -> None:
        try:
            await websocket.send(json.dumps(build_finish_task(task_id, cancel=True)))
        except Exception:
            return


__all__ = [
    "Connector",
    "QwenAudioTts",
    "ResultType",
    "ServerEvent",
    "ServerEventType",
    "WebSocketConnection",
    "build_continue_task",
    "build_finish_task",
    "build_run_task",
    "parse_server_event",
]
