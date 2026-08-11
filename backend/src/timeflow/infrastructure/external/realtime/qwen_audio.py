"""Aliyun Qwen-Audio realtime adapter: speaks the vendor's wire format, reports plainly."""

import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Our protocol owns turn boundaries; the model must not also decide when a turn ended.
PUSH_TO_TALK: None = None

# The model accepts 16 kHz mono PCM in and emits 24 kHz mono PCM out.
INPUT_SAMPLE_RATE_HZ = 16_000
OUTPUT_SAMPLE_RATE_HZ = 24_000


class Transport(Protocol):
    """The subset of a WebSocket this adapter uses, so tests can supply their own."""

    async def send(self, message: str) -> None:
        """Send one text frame."""
        ...

    async def recv(self) -> str | bytes:
        """Receive the next frame."""
        ...

    async def close(self) -> None:
        """Close the connection."""
        ...


class Observer(Protocol):
    """Where this adapter reports what the model says; restated, never imported."""

    async def heard(self, text: str) -> None:
        """The model reported what the user said."""
        ...

    async def spoke(self, text: str) -> None:
        """The model reported the words it is saying."""
        ...

    async def audio(self, data: bytes) -> None:
        """One chunk of the model's own speech, decoded to raw bytes."""
        ...

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """The model asked for a tool to run."""
        ...

    async def failed(self, message: str) -> None:
        """The session cannot continue."""
        ...


@dataclass(frozen=True, slots=True)
class QwenAudioConfig:
    """Where to reach the model and how to authenticate."""

    api_key: str
    workspace_id: str
    model: str
    region: str = "cn-beijing"
    voice: str = "longanqian"

    def url(self) -> str:
        """Build the region- and workspace-specific realtime endpoint."""
        host = f"{self.workspace_id}.{self.region}.maas.aliyuncs.com"
        return f"wss://{host}/api-ws/v1/realtime?model={self.model}"

    def headers(self) -> dict[str, str]:
        """Build the auth headers; the key never appears in logs or errors."""
        return {"Authorization": f"Bearer {self.api_key}"}


class QwenAudioSession:
    """One turn's conversation with the model, translated to domain events."""

    def __init__(self, transport: Transport, config: QwenAudioConfig) -> None:
        """Store the open transport and the config it was opened with."""
        self._transport = transport
        self._config = config
        # A tool makes a turn two responses; the second one carries the audio.
        self._open_responses = 0

    async def configure(self, instructions: str, tools: list[dict[str, Any]]) -> None:
        """Set the session up before any audio; turn_detection only takes effect here."""
        session: dict[str, Any] = {
            "modalities": ["text", "audio"],
            "voice": self._config.voice,
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "turn_detection": PUSH_TO_TALK,
        }
        if instructions:
            session["instructions"] = instructions
        if tools:
            session["tools"] = tools
        await self._send({"type": "session.update", "session": session})

    async def send_audio(self, chunk: bytes) -> None:
        """Append one chunk of the user's speech, base64 encoded as the vendor expects."""
        await self._send(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }
        )

    async def finish_input(self) -> None:
        """Commit the buffered audio and ask for a reply."""
        await self._send({"type": "input_audio_buffer.commit"})
        await self._send({"type": "response.create"})
        self._open_responses += 1

    async def send_tool_result(self, call_id: str, output: str) -> None:
        """Write a tool's output back and let the model continue from it."""
        await self._send(
            {
                "type": "conversation.item.create",
                "item": {"type": "function_call_output", "call_id": call_id, "output": output},
            }
        )
        await self._send({"type": "response.create"})
        self._open_responses += 1

    async def close(self) -> None:
        """Close the underlying connection, ignoring an already-closed one."""
        try:
            await self._transport.close()
        except Exception:  # noqa: BLE001 - closing must not mask the original outcome
            logger.debug("closing a realtime session that was already gone")

    async def _send(self, event: dict[str, Any]) -> None:
        """Serialize and send one client event."""
        await self._transport.send(json.dumps(event, ensure_ascii=False))

    async def pump(self, observer: Observer) -> None:
        """Report what the model says, decoded and renamed, until the turn ends or fails."""
        spoken = ""
        while True:
            try:
                raw = await self._transport.recv()
            except Exception as error:  # noqa: BLE001 - any transport failure ends the turn
                await observer.failed(f"realtime transport failed: {type(error).__name__}")
                return

            if isinstance(raw, bytes):
                # The vendor sends everything as JSON text; a binary frame is unexpected.
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                await observer.failed("realtime session sent a non-JSON frame")
                return
            if not isinstance(event, dict):
                await observer.failed("realtime session sent a non-object frame")
                return

            kind = event.get("type")

            if kind == "conversation.item.input_audio_transcription.completed":
                await observer.heard(str(event.get("transcript", "")))
            elif kind == "response.audio_transcript.delta":
                spoken += str(event.get("delta", ""))
                await observer.spoke(spoken)
            elif kind == "response.audio_transcript.done":
                # Reported again in case the reply was short enough to skip increments.
                final = str(event.get("transcript", ""))
                if final and final != spoken:
                    spoken = final
                    await observer.spoke(spoken)
            elif kind == "response.audio.delta":
                decoded = _decode_audio(event.get("delta"))
                if decoded:
                    await observer.audio(decoded)
            elif kind == "response.function_call_arguments.done":
                requested = _tool_request(event)
                if requested is None:
                    await observer.failed("realtime session sent an unusable tool call")
                    return
                await observer.tool_requested(**requested)
            elif kind == "response.done":
                # Not the turn's end if a tool ran: the next response is the one that speaks.
                self._open_responses -= 1
                if self._open_responses <= 0:
                    return
            elif kind == "error":
                await observer.failed(_error_message(event))
                return


def _decode_audio(delta: Any) -> bytes:
    """Decode one base64 audio delta, dropping a malformed one rather than failing the turn."""
    if not isinstance(delta, str) or not delta:
        return b""
    try:
        return base64.b64decode(delta, validate=True)
    except (ValueError, TypeError):
        logger.warning("dropped a malformed audio delta from the realtime session")
        return b""


def _tool_request(event: dict[str, Any]) -> dict[str, Any] | None:
    """Lift a tool call out of a vendor event, or None when it cannot be acted on."""
    call_id = event.get("call_id")
    name = event.get("name")
    if not isinstance(call_id, str) or not isinstance(name, str):
        return None
    raw_arguments = event.get("arguments")
    arguments: dict[str, Any] = {}
    if isinstance(raw_arguments, str) and raw_arguments:
        try:
            parsed = json.loads(raw_arguments)
        except json.JSONDecodeError:
            logger.warning("realtime session sent unparsable tool arguments")
            return None
        if isinstance(parsed, dict):
            arguments = parsed
    return {"call_id": call_id, "name": name, "arguments": arguments}


def _error_message(event: dict[str, Any]) -> str:
    """Extract a readable message from a vendor error event."""
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return message
    return "realtime session reported an error"


class QwenAudioSessionFactory:
    """Open one configured session per turn."""

    def __init__(
        self,
        config: QwenAudioConfig,
        *,
        connect: Any = None,
        open_timeout_seconds: float = 10.0,
    ) -> None:
        """Store the config plus the connect seam tests replace."""
        self._config = config
        self._connect = connect
        self._open_timeout_seconds = open_timeout_seconds

    async def open(self, instructions: str, tools: list[dict[str, Any]]) -> QwenAudioSession:
        """Connect, configure, and return a session ready for audio.
        Closes on failure: a socket the caller never receives is one nobody can close.
        """
        connect = self._connect or _default_connect
        async with asyncio.timeout(self._open_timeout_seconds):
            transport = await connect(self._config)
            session = QwenAudioSession(transport, self._config)
            try:
                await session.configure(instructions, tools)
            except BaseException:
                await session.close()
                raise
        return session


async def _default_connect(config: QwenAudioConfig) -> Transport:
    """Open a real WebSocket to the vendor endpoint."""
    import websockets

    connection = await websockets.connect(
        config.url(), additional_headers=config.headers(), max_size=None
    )
    return connection
