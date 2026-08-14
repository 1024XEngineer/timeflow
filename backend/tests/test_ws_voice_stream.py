"""Audio frame lifecycle for the WebSocket transport."""

import threading
from collections.abc import AsyncIterator
from typing import Any

from auth_test_support import build_test_token_service
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.handlers.voice_stream import VoiceStreamHandlers
from timeflow.gateway.websocket.ports import AudioSink, StreamContext
from timeflow.gateway.websocket.router import MessageRouter

_TOKENS = build_test_token_service()
VALID_HELLO: dict[str, Any] = {
    "type": "session.hello",
    "request_id": "req_001",
    "payload": {
        "access_token": _TOKENS.issue("acc_test").access_token,
        "device_id": "device_001",
    },
}
START: dict[str, Any] = {
    "type": "voice.stream.start",
    "request_id": "req_002",
    "payload": {
        "conversation_id": None,
        "audio_format": "pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
    },
}


class CapturingSink:
    """Record every chunk of every stream, and signal when a stream completes."""

    def __init__(self) -> None:
        """Start with nothing captured."""
        self.chunks: list[bytes] = []
        self.streams: list[StreamContext] = []
        self.completed = threading.Event()

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Collect the stream's chunks in arrival order."""
        self.streams.append(stream)
        async for chunk in chunks:
            self.chunks.append(chunk)
        self.completed.set()

    def audio(self) -> bytes:
        """Return everything received, concatenated."""
        return b"".join(self.chunks)


class ExplodingSink:
    """A sink that fails the way a provider outage would."""

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Fail before reading anything."""
        raise RuntimeError("the sink is unavailable")


def _build_app(
    sink: AudioSink,
    *,
    max_audio_duration_ms: int = 120_000,
    max_continuous_audio_duration_ms: int = 1_800_000,
    queue_max_chunks: int = 32,
) -> FastAPI:
    """Build an app wiring the transport to the given sink."""
    application = FastAPI()
    handshake = SessionHandshake(_TOKENS, session_id_factory=lambda: "ws_session_test")
    connections = ConnectionManager()
    limiter = UnauthenticatedConnectionLimiter(100)
    voice_streams = VoiceStreamHandlers(
        sink,
        max_audio_duration_ms=max_audio_duration_ms,
        max_continuous_audio_duration_ms=max_continuous_audio_duration_ms,
        queue_max_chunks=queue_max_chunks,
        stream_id_factory=lambda: "stream_test",
        conversation_id_factory=lambda: "conversation_test",
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)

    @application.websocket("/ws")
    async def endpoint(websocket: WebSocket) -> None:
        """Serve one transport session."""
        await run_websocket_session(
            websocket,
            handshake,
            router,
            connections,
            limiter,
            handshake_timeout_seconds=5.0,
            binary_handler=voice_streams.handle_binary,
            disconnect_handler=voice_streams.handle_disconnect,
        )

    return application


def test_stream_start_assigns_stream_and_conversation_ids() -> None:
    """voice.stream.start is acknowledged with both identifiers."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        reply = websocket.receive_json()

    assert reply["type"] == "voice.stream.started"
    assert reply["ok"] is True
    assert reply["request_id"] == "req_002"
    assert reply["payload"] == {
        "stream_id": "stream_test",
        "conversation_id": "conversation_test",
    }


def test_a_supplied_conversation_id_is_kept() -> None:
    """A conversation id sent by the client is echoed rather than replaced."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))
    start = {**START, "payload": {**START["payload"], "conversation_id": "conversation_prev"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(start)
        reply = websocket.receive_json()

    assert reply["payload"]["conversation_id"] == "conversation_prev"


def test_audio_reaches_the_sink_intact_and_in_order() -> None:
    """Every binary frame arrives at the sink, byte for byte, in send order."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))
    frames = [b"\x01\x02" * 8, b"\x03\x04" * 8, b"\x05\x06" * 8]

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        for frame in frames:
            websocket.send_bytes(frame)
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)

    assert sink.audio() == b"".join(frames)
    assert sink.chunks == frames


def test_stream_end_sends_no_reply() -> None:
    """Closing a stream is silent this round, since no transcript exists yet."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)
        websocket.send_json({"type": "unknown.type"})
        next_reply = websocket.receive_json()

    assert next_reply["error"]["code"] == "UNKNOWN_MESSAGE_TYPE"


def test_binary_frame_before_start_is_refused() -> None:
    """Audio may not be sent before a stream is opened."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        reply = websocket.receive_json()

    assert reply["ok"] is False
    assert reply["error"]["code"] == "AUDIO_INVALID"
    assert sink.chunks == []


def test_second_start_does_not_disturb_the_active_stream() -> None:
    """A duplicate voice.stream.start is refused and the first stream keeps running."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_json(START)
        refusal = websocket.receive_json()
        websocket.send_bytes(b"\x07\x08")
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)

    assert refusal["error"]["code"] == "AUDIO_INVALID"
    assert sink.audio() == b"\x07\x08"


def test_mismatched_stream_id_on_end_is_refused() -> None:
    """Closing a stream requires the stream id the server assigned."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "wrong"}})
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"


def test_closing_an_empty_stream_is_refused() -> None:
    """A stream that carried no audio is rejected rather than sent onward."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"
    assert sink.streams == []


def test_empty_binary_frame_is_refused_without_ending_the_stream() -> None:
    """An empty frame is reported but the stream stays usable."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"")
        refusal = websocket.receive_json()
        websocket.send_bytes(b"\x09\x0a")
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)

    assert refusal["error"]["code"] == "AUDIO_INVALID"
    assert sink.audio() == b"\x09\x0a"


def test_audio_exactly_at_the_duration_budget_is_accepted() -> None:
    """Audio filling the budget precisely is still within it.

    Guards the comparison at the limit: 10 ms of 16 kHz mono 16-bit audio is 320 bytes,
    and 320 must pass where 321 does not.
    """
    sink = CapturingSink()
    client = TestClient(_build_app(sink, max_audio_duration_ms=10))
    frame = b"\x00" * 320

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(frame)
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)

    assert sink.audio() == frame


def test_closing_a_stream_without_a_stream_id_is_refused() -> None:
    """An end message must say which stream it closes."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        websocket.send_json({"type": "voice.stream.end", "payload": {}})
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"


def test_a_conversation_id_of_the_wrong_kind_is_refused() -> None:
    """A conversation id that is not a string is malformed, not silently replaced."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))
    start = {**START, "payload": {**START["payload"], "conversation_id": 123}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(start)
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"


def test_audio_beyond_the_duration_budget_is_refused() -> None:
    """Audio exceeding the configured duration terminates the stream."""
    sink = CapturingSink()
    # 10 ms of 16 kHz mono 16-bit audio is 320 bytes.
    client = TestClient(_build_app(sink, max_audio_duration_ms=10))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x00" * 321)
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"
    assert "10 ms" in reply["error"]["message"]


def test_continuous_mode_uses_its_own_larger_duration_budget() -> None:
    """continuous mode is not held to push-to-talk's one-press-and-hold budget.

    Audio that would overrun the push-to-talk budget is accepted here because the stream
    is in continuous mode, which draws from a separate, much larger budget.
    """
    sink = CapturingSink()
    # 10 ms of push-to-talk budget; 100 ms of continuous budget. 321 bytes is ~10 ms.
    client = TestClient(
        _build_app(sink, max_audio_duration_ms=10, max_continuous_audio_duration_ms=100)
    )
    hello = {**VALID_HELLO, "payload": {**VALID_HELLO["payload"], "voice_mode": "continuous"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x00" * 321)
        websocket.send_json({"type": "voice.stream.end", "payload": {"stream_id": "stream_test"}})
        assert sink.completed.wait(timeout=2)

    assert sink.audio() == b"\x00" * 321


def test_unsupported_audio_format_is_refused() -> None:
    """Only the formats the transport declares support for are accepted."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))
    start = {**START, "payload": {**START["payload"], "audio_format": "mp3"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(start)
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"
    assert "mp3" in reply["error"]["message"]


def test_unsupported_sample_rate_is_refused() -> None:
    """A sample rate the transport cannot forward is rejected at start."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))
    start = {**START, "payload": {**START["payload"], "sample_rate_hz": 44100}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(start)
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "AUDIO_INVALID"
    assert "44100" in reply["error"]["message"]


def test_a_failing_sink_does_not_wedge_the_session() -> None:
    """When the sink dies, the session keeps answering instead of seizing up.

    Nothing drains the queue once the sink is gone, so without retiring the stream the
    receive loop parks on a full queue and the connection never responds again. More
    frames than the queue holds are sent here to force exactly that situation.
    """
    client = TestClient(_build_app(ExplodingSink(), queue_max_chunks=4))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        for _ in range(12):
            websocket.send_bytes(b"\x00" * 320)
        websocket.send_json({"type": "unknown.probe"})

        replies = [websocket.receive_json() for _ in range(1)]

    assert replies[0]["ok"] is False


def test_disconnect_cancels_an_unfinished_stream() -> None:
    """Dropping the connection mid-stream leaves no work running."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")

    assert not sink.completed.is_set()


def test_an_audio_error_names_the_conversation_it_belongs_to() -> None:
    """voice.command.error carries a top-level conversation_id when a stream exists.

    The interface design shows the field on this envelope; it was previously omitted
    because nothing read it yet.
    """
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()

        websocket.send_bytes(b"")
        refused = websocket.receive_json()

        assert refused["type"] == "voice.command.error"
        assert refused["conversation_id"] == "conversation_test"


def test_an_error_with_no_conversation_omits_the_field() -> None:
    """An error raised before any stream exists names no conversation rather than a fake one."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()

        websocket.send_bytes(b"audio without a stream")
        refused = websocket.receive_json()

        assert refused["type"] == "voice.command.error"
        assert "conversation_id" not in refused


def test_a_rejected_second_start_names_the_conversation_holding_the_stream() -> None:
    """Being told a stream is already active says which conversation is holding it."""
    sink = CapturingSink()
    client = TestClient(_build_app(sink))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()

        websocket.send_json(START)
        refused = websocket.receive_json()

        assert refused["type"] == "voice.command.error"
        assert "already active" in refused["error"]["message"]
        assert refused["conversation_id"] == "conversation_test"
