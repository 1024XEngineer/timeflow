"""The turn from inbound audio to a delivered result."""

import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from timeflow.gateway.websocket.agent_ports import Agent, StreamIdentity
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.agent_audio import AgentAudioSink
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.gateway.websocket.handlers.message_ack import handle_message_ack
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.handlers.voice_stream import VoiceStreamHandlers
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.security.token_verifier import FakeTokenVerifier
from timeflow.intelligence.fake_agent import (
    FAKE_REPLY_STEPS,
    FAKE_TRANSCRIPT,
    FakeAgent,
)

VALID_HELLO: dict[str, Any] = {
    "type": "session.hello",
    "request_id": "req_session_001",
    "payload": {"access_token": "token-abc", "device_id": "device_001"},
}
START: dict[str, Any] = {
    "type": "voice.stream.start",
    "request_id": "req_voice_001",
    "payload": {
        "conversation_id": None,
        "audio_format": "pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
    },
}
END: dict[str, Any] = {
    "type": "voice.stream.end",
    "request_id": "req_voice_001",
    "payload": {"stream_id": "stream_test"},
}


@dataclass(frozen=True, slots=True)
class _Identity:
    """Stand-in for the identifiers the transport hands to an agent."""

    session_id: str
    stream_id: str
    conversation_id: str
    request_id: str | None


class CapturingAgent:
    """Record the audio an agent receives, and signal when the stream ended."""

    def __init__(self) -> None:
        """Start with nothing captured."""
        self.chunks: list[bytes] = []
        self.streams: list[StreamIdentity] = []
        self.completed = threading.Event()

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamIdentity) -> None:
        """Collect the stream's chunks in arrival order."""
        self.streams.append(stream)
        async for chunk in chunks:
            self.chunks.append(chunk)
        self.completed.set()

    def audio(self) -> bytes:
        """Return everything received, concatenated."""
        return b"".join(self.chunks)


def _build_app(agent: Agent | None = None, *, max_audio_duration_ms: int = 120_000) -> FastAPI:
    """Build an app wiring the transport to an agent, with fixed identifiers."""
    application = FastAPI()
    connections = ConnectionManager()
    handshake = SessionHandshake(FakeTokenVerifier(), session_id_factory=lambda: "ws_session_test")
    limiter = UnauthenticatedConnectionLimiter(100)
    voice_streams = VoiceStreamHandlers(
        AgentAudioSink(
            agent
            or FakeAgent(
                WebSocketResultSink(connections),
                message_id_factory=lambda: "msg_test",
            )
        ),
        max_audio_duration_ms=max_audio_duration_ms,
        stream_id_factory=lambda: "stream_test",
        conversation_id_factory=lambda: "conversation_test",
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)
    router.register("message.ack", handle_message_ack)

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


def test_a_finished_stream_yields_the_transcript_the_result_then_the_reply() -> None:
    """Closing a stream pushes what was heard, then what was done, then what is said."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02" * 160)
        websocket.send_json(END)
        received = [websocket.receive_json() for _ in range(2 + len(FAKE_REPLY_STEPS))]

    assert [message["type"] for message in received] == [
        "voice.asr.completed",
        "voice.command.result",
        *["voice.dialogue.reply"] * len(FAKE_REPLY_STEPS),
    ]


def test_the_reply_arrives_as_a_growing_whole_under_one_reply_id() -> None:
    """Each update carries everything said so far, and only the last says it is done."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02" * 160)
        websocket.send_json(END)
        websocket.receive_json()
        websocket.receive_json()
        replies = [websocket.receive_json() for _ in FAKE_REPLY_STEPS]

    payloads = [reply["payload"] for reply in replies]
    assert len({payload["reply_id"] for payload in payloads}) == 1
    texts = [payload["speech_text"] for payload in payloads]
    assert texts == list(FAKE_REPLY_STEPS)
    for earlier, later in zip(texts, texts[1:], strict=False):
        assert later.startswith(earlier)
    assert [payload["done"] for payload in payloads] == [False, False, True]


def test_the_transcript_message_matches_the_documented_shape() -> None:
    """voice.asr.completed carries its identifiers beside payload and omits ok."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02" * 160)
        websocket.send_json(END)
        transcript = websocket.receive_json()

    assert transcript["request_id"] == "req_voice_001"
    assert transcript["conversation_id"] == "conversation_test"
    assert "ok" not in transcript
    assert transcript["payload"]["transcript"] == FAKE_TRANSCRIPT
    assert transcript["payload"]["language"] == "zh"
    assert transcript["payload"]["duration_ms"] == 10


def test_the_command_result_message_matches_the_documented_shape() -> None:
    """voice.command.result carries message_id at the top level and omits ok."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02" * 160)
        websocket.send_json(END)
        websocket.receive_json()
        result = websocket.receive_json()

    assert result["message_id"] == "msg_test"
    assert result["request_id"] == "req_voice_001"
    assert result["conversation_id"] == "conversation_test"
    assert "ok" not in result
    assert result["payload"]["operation"] == "create_schedule"
    assert result["payload"]["status"] == "applied"
    assert result["payload"]["schedule"]["id"] == "schedule_fake_001"


def test_the_agent_receives_the_audio_unchanged() -> None:
    """Every byte reaches the agent in send order, with no transcription in between."""
    agent = CapturingAgent()
    client = TestClient(_build_app(agent))
    frames = [b"\x01\x02" * 8, b"\x03\x04" * 8, b"\x05\x06" * 8]

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        for frame in frames:
            websocket.send_bytes(frame)
        websocket.send_json(END)
        assert agent.completed.wait(timeout=2)

    assert agent.chunks == frames
    assert agent.audio() == b"".join(frames)


def test_the_agent_receives_the_stream_identifiers() -> None:
    """The agent is told which session, stream, conversation and request it is serving."""
    agent = CapturingAgent()
    client = TestClient(_build_app(agent))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        websocket.send_json(END)
        assert agent.completed.wait(timeout=2)

    assert len(agent.streams) == 1
    stream = agent.streams[0]
    assert stream.session_id == "ws_session_test"
    assert stream.stream_id == "stream_test"
    assert stream.conversation_id == "conversation_test"
    assert stream.request_id == "req_voice_001"


def test_an_acknowledgement_is_accepted_silently() -> None:
    """message.ack draws no reply, so the next reply belongs to the message after it."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json({"type": "message.ack", "message_id": "msg_test", "status": "applied"})
        websocket.send_json({"type": "unknown.probe"})
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "UNKNOWN_MESSAGE_TYPE"


def test_acknowledging_an_unknown_message_is_not_an_error() -> None:
    """An ack for a message the server never sent is accepted as already done."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json({"type": "message.ack", "message_id": "msg_never", "status": "applied"})
        websocket.send_json({"type": "message.ack", "message_id": "msg_never", "status": "applied"})
        websocket.send_json({"type": "unknown.probe"})
        reply = websocket.receive_json()

    assert reply["error"]["code"] == "UNKNOWN_MESSAGE_TYPE"


def test_a_malformed_acknowledgement_is_refused() -> None:
    """An ack without message_id is reported rather than silently accepted."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json({"type": "message.ack", "status": "applied"})
        reply = websocket.receive_json()

    assert reply["ok"] is False
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"


def test_disconnecting_before_the_stream_ends_delivers_nothing() -> None:
    """Dropping the connection mid-stream leaves the turn unfinished and unsent."""
    agent = CapturingAgent()
    client = TestClient(_build_app(agent))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")

    assert not agent.completed.is_set()


def test_audio_beyond_the_budget_delivers_no_result() -> None:
    """A stream cut off for exceeding its budget produces no turn at all."""
    agent = CapturingAgent()
    # 10 ms of 16 kHz mono 16-bit audio is 320 bytes.
    client = TestClient(_build_app(agent, max_audio_duration_ms=10))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x00" * 200)
        websocket.send_bytes(b"\x00" * 200)
        refusal = websocket.receive_json()

    assert refusal["error"]["code"] == "AUDIO_INVALID"
    assert not agent.completed.is_set()


def test_audio_survives_a_stream_longer_than_the_queue() -> None:
    """Every byte reaches the agent even when the stream far exceeds the queue depth."""
    agent = CapturingAgent()
    client = TestClient(_build_app(agent))
    frames = [bytes([index % 256]) * 320 for index in range(200)]

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        for frame in frames:
            websocket.send_bytes(frame)
        websocket.send_json(END)
        assert agent.completed.wait(timeout=10)

    assert agent.chunks == frames
    assert agent.audio() == b"".join(frames)


def test_a_later_turn_keeps_the_conversation_it_was_given() -> None:
    """A second turn carrying the first turn's conversation id stays in that conversation."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive_json()
        websocket.send_json(START)
        websocket.receive_json()
        websocket.send_bytes(b"\x01\x02" * 160)
        websocket.send_json(END)
        first_transcript = websocket.receive_json()
        websocket.receive_json()

        continued = {
            **START,
            "payload": {**START["payload"], "conversation_id": first_transcript["conversation_id"]},
        }
        websocket.send_json(continued)
        websocket.receive_json()
        websocket.send_bytes(b"\x03\x04" * 160)
        websocket.send_json(END)
        second_transcript = websocket.receive_json()
        second_result = websocket.receive_json()

    assert second_transcript["conversation_id"] == first_transcript["conversation_id"]
    assert second_result["conversation_id"] == first_transcript["conversation_id"]
