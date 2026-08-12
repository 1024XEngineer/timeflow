"""Translating the vendor's realtime wire format, with a fake transport."""

import asyncio
import base64
import json
from typing import Any

from timeflow.infrastructure.external.realtime.qwen_audio import (
    Observer,
    QwenAudioConfig,
    QwenAudioSession,
    QwenAudioSessionFactory,
)
from timeflow.intelligence.realtime.ports import (
    RealtimeSession,
    RealtimeSessionFactory,
    TurnObserver,
)

CONFIG = QwenAudioConfig(
    api_key="key-abc", workspace_id="ws_001", model="qwen-audio-3.0-realtime-plus"
)


class FakeTransport:
    """A stand-in socket: records what was sent, replays a scripted server side."""

    def __init__(self, *inbound: str) -> None:
        """Queue the frames the server will send, in order."""
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        self._inbound = list(inbound)

    async def send(self, message: str) -> None:
        """Record one client event."""
        self.sent.append(json.loads(message))

    async def recv(self) -> str:
        """Return the next scripted frame, raising once the script runs out.

        Raising rather than blocking: reading past a turn fails now, not on CI timeout.
        """
        if not self._inbound:
            raise AssertionError("the pump read past the end of the scripted turn")
        return self._inbound.pop(0)

    async def close(self) -> None:
        """Mark the connection closed."""
        self.closed = True

    def types(self) -> list[str]:
        """Return the type of every client event sent, in order."""
        return [str(event["type"]) for event in self.sent]


class RecordingObserver:
    """Collect what the session reports, in arrival order."""

    def __init__(self) -> None:
        """Start with nothing observed."""
        self.calls: list[tuple[str, Any]] = []

    async def heard(self, text: str) -> None:
        """Record the user's transcript."""
        self.calls.append(("heard", text))

    async def spoke(self, text: str) -> None:
        """Record the assistant's own words."""
        self.calls.append(("spoke", text))

    async def audio(self, data: bytes) -> None:
        """Record one decoded audio chunk."""
        self.calls.append(("audio", data))

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """Record a tool call request."""
        self.calls.append(("tool", (call_id, name, arguments)))

    async def failed(self, message: str) -> None:
        """Record a session failure."""
        self.calls.append(("failed", message))

    def kinds(self) -> list[str]:
        """Return just the kind of each observed call."""
        return [kind for kind, _ in self.calls]


def _event(kind: str, **fields: Any) -> str:
    """Build one server frame."""
    return json.dumps({"type": kind, **fields})


def test_the_endpoint_carries_the_workspace_and_model() -> None:
    """The URL is built per workspace and region, and the key rides in a header."""
    assert CONFIG.url() == (
        "wss://ws_001.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime"
        "?model=qwen-audio-3.0-realtime-plus"
    )
    assert CONFIG.headers() == {"Authorization": "Bearer key-abc"}


def test_configure_puts_the_session_in_push_to_talk() -> None:
    """turn_detection is null, because our own protocol owns turn boundaries.

    Letting the model decide when a turn ended would race voice.stream.end: it would
    answer before the client said it had finished speaking.
    """

    async def scenario() -> None:
        """Configure a session and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG)

        await session.configure("你是日程助手", [{"type": "function"}])

        assert transport.types() == ["session.update"]
        sent = transport.sent[0]["session"]
        assert sent["turn_detection"] is None
        assert sent["modalities"] == ["text", "audio"]
        assert sent["input_audio_format"] == "pcm"
        assert sent["output_audio_format"] == "pcm"
        assert sent["instructions"] == "你是日程助手"
        assert sent["tools"] == [{"type": "function"}]

    asyncio.run(scenario())


def test_audio_is_base64_encoded_on_the_way_out() -> None:
    """The vendor takes audio as base64 inside a JSON event, not as binary frames."""

    async def scenario() -> None:
        """Send one chunk and inspect the frame."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG)

        await session.send_audio(b"\x01\x02\x03")

        assert transport.types() == ["input_audio_buffer.append"]
        assert base64.b64decode(transport.sent[0]["audio"]) == b"\x01\x02\x03"

    asyncio.run(scenario())


def test_finishing_input_commits_then_asks_for_a_reply() -> None:
    """Both events are needed and in this order; commit alone produces no answer."""

    async def scenario() -> None:
        """Finish the input and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG)

        await session.finish_input()

        assert transport.types() == ["input_audio_buffer.commit", "response.create"]

    asyncio.run(scenario())


def test_a_turn_is_reported_as_transcript_speech_audio_then_ends() -> None:
    """Vendor event names and base64 stay inside the adapter."""

    async def scenario() -> None:
        """Replay a full turn and read what the observer saw."""
        transport = FakeTransport(
            _event("conversation.item.input_audio_transcription.completed", transcript="明天开会"),
            _event("response.audio_transcript.done", transcript="好，记下了"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-1").decode()),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-2").decode()),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [
            ("heard", "明天开会"),
            ("spoke", "好，记下了"),
            ("audio", b"pcm-1"),
            ("audio", b"pcm-2"),
        ]

    asyncio.run(scenario())


def test_pump_returns_when_the_turn_is_done() -> None:
    """response.done ends the loop rather than leaving it waiting on the socket."""

    async def scenario() -> None:
        """Replay a turn that only says it finished."""
        transport = FakeTransport(_event("response.done"))

        await asyncio.wait_for(
            QwenAudioSession(transport, CONFIG).pump(RecordingObserver()), timeout=1.0
        )

    asyncio.run(scenario())


def test_a_tool_call_is_reported_with_parsed_arguments() -> None:
    """Arguments arrive as a JSON string and are handed over already parsed."""

    async def scenario() -> None:
        """Replay a tool call request."""
        transport = FakeTransport(
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="list_schedules",
                arguments='{"range":"this_week"}',
            ),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [("tool", ("call_1", "list_schedules", {"range": "this_week"}))]

    asyncio.run(scenario())


def test_a_tool_call_without_a_call_id_fails_the_turn() -> None:
    """A tool call that cannot be answered ends the turn instead of being half-run.

    Without call_id there is no way to write the result back, so continuing would leave
    the model waiting forever.
    """

    async def scenario() -> None:
        """Replay a tool call missing its identifier."""
        transport = FakeTransport(
            _event("response.function_call_arguments.done", name="list_schedules", arguments="{}")
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        # The reason matters, not just that it failed: reading past the end of the script
        # also reports a failure, so a weaker assertion would pass even if this guard
        # were removed.
        assert observer.kinds() == ["failed"]
        assert "tool call" in observer.calls[0][1]

    asyncio.run(scenario())


def test_sending_a_tool_result_lets_the_model_continue() -> None:
    """The output is written back as a conversation item, then a reply is requested."""

    async def scenario() -> None:
        """Send a tool result and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG)

        await session.send_tool_result("call_1", '{"count":2}')

        assert transport.types() == ["conversation.item.create", "response.create"]
        item = transport.sent[0]["item"]
        assert item == {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": '{"count":2}',
        }

    asyncio.run(scenario())


def test_a_malformed_audio_delta_is_dropped_not_fatal() -> None:
    """One bad chunk does not end a turn that is otherwise fine."""

    async def scenario() -> None:
        """Replay a turn containing one undecodable delta."""
        transport = FakeTransport(
            _event("response.audio.delta", delta="not-base64!!"),
            _event("response.audio.delta", delta=base64.b64encode(b"good").decode()),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [("audio", b"good")]

    asyncio.run(scenario())


def test_a_vendor_error_event_fails_the_turn_with_its_message() -> None:
    """The vendor's own message is surfaced rather than replaced by a generic one."""

    async def scenario() -> None:
        """Replay an error event."""
        transport = FakeTransport(_event("error", error={"message": "quota exceeded"}))
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [("failed", "quota exceeded")]

    asyncio.run(scenario())


def test_a_dropped_connection_fails_the_turn() -> None:
    """A transport error ends the turn instead of propagating out of the pump."""

    async def scenario() -> None:
        """Replay a transport that raises on receive."""

        class BrokenTransport(FakeTransport):
            """A socket that fails on the first receive."""

            async def recv(self) -> str:
                """Fail as a dropped connection would."""
                raise ConnectionResetError

        observer = RecordingObserver()

        await QwenAudioSession(BrokenTransport(), CONFIG).pump(observer)

        assert observer.kinds() == ["failed"]
        assert "ConnectionResetError" in observer.calls[0][1]

    asyncio.run(scenario())


def test_unknown_vendor_events_are_ignored() -> None:
    """Events this adapter does not act on do not stop the turn.

    The vendor emits many lifecycle events (session.created, response.created, speech
    started/stopped); reacting to an unknown one would break on every API addition.
    """

    async def scenario() -> None:
        """Replay lifecycle noise around one real event."""
        transport = FakeTransport(
            _event("session.created"),
            _event("response.created"),
            _event("input_audio_buffer.speech_started"),
            _event("conversation.item.input_audio_transcription.completed", transcript="喂"),
            _event("response.output_item.added"),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [("heard", "喂")]

    asyncio.run(scenario())


def test_opening_a_session_connects_then_configures() -> None:
    """The factory hands back a session that is already in push-to-talk."""

    async def scenario() -> None:
        """Open a session through the factory with a fake connect."""
        transport = FakeTransport()

        async def connect(config: QwenAudioConfig) -> FakeTransport:
            """Return the fake transport instead of dialling out."""
            assert config is CONFIG
            return transport

        factory = QwenAudioSessionFactory(CONFIG, connect=connect)
        session = await factory.open("你是日程助手", [])

        assert isinstance(session, QwenAudioSession)
        assert transport.types() == ["session.update"]

    asyncio.run(scenario())


def test_closing_a_session_that_already_went_away_is_not_an_error() -> None:
    """Cleanup must not raise, or a failed turn would fail twice."""

    async def scenario() -> None:
        """Close a transport that raises on close."""

        class RefusesToClose(FakeTransport):
            """A socket that fails when closed."""

            async def close(self) -> None:
                """Fail as an already-closed socket would."""
                raise ConnectionResetError

        await QwenAudioSession(RefusesToClose(), CONFIG).close()

    asyncio.run(scenario())


def test_the_reply_text_is_reported_from_its_increments() -> None:
    """spoke carries the text accumulated so far, so it is ready before the audio starts.

    Measured against the real model the increments finish well before the first audio
    chunk, while the terminal event lands after it. Reporting only on the terminal event
    would leave the first audio chunk with no text beside it.
    """

    async def scenario() -> None:
        """Replay a reply whose text streams in three increments before any audio."""
        transport = FakeTransport(
            _event("response.audio_transcript.delta", delta="好，"),
            _event("response.audio_transcript.delta", delta="明天三点"),
            _event("response.audio_transcript.delta", delta="记下了"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm").decode()),
            _event("response.audio_transcript.done", transcript="好，明天三点记下了"),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [
            ("spoke", "好，"),
            ("spoke", "好，明天三点"),
            ("spoke", "好，明天三点记下了"),
            ("audio", b"pcm"),
        ]

    asyncio.run(scenario())


def test_a_reply_with_no_increments_is_still_reported() -> None:
    """A reply that only arrives as a terminal event is not lost."""

    async def scenario() -> None:
        """Replay a reply that skips increments entirely."""
        transport = FakeTransport(
            _event("response.audio_transcript.done", transcript="好"),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG).pump(observer)

        assert observer.calls == [("spoke", "好")]

    asyncio.run(scenario())


def test_the_adapter_satisfies_the_dialogue_layer_s_ports() -> None:
    """The two declarations of the seam are the same shape.

    Neither side imports the other, so nothing else would notice one of them drifting.
    mypy rejects these assignments the moment they stop matching; no call site needed.
    """
    session: RealtimeSession = QwenAudioSession(FakeTransport(), CONFIG)
    factory: RealtimeSessionFactory = QwenAudioSessionFactory(CONFIG)
    observer: Observer = _SeamObserver()
    also_a_turn_observer: TurnObserver = _SeamObserver()

    assert (session, factory, observer, also_a_turn_observer) is not None


class _SeamObserver:
    """An observer written once and checked against both declarations of the shape."""

    async def heard(self, text: str) -> None:
        """Ignore what the user said."""

    async def spoke(self, text: str) -> None:
        """Ignore what the model said."""

    async def audio(self, data: bytes) -> None:
        """Ignore the model's speech."""

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """Ignore the tool request."""

    async def failed(self, message: str) -> None:
        """Ignore the failure."""


def test_a_session_that_cannot_be_configured_closes_its_transport() -> None:
    """A socket the caller never receives is a socket nobody can close."""

    class RefusingTransport(FakeTransport):
        """A transport that connects and then refuses the session update."""

        async def send(self, message: str) -> None:
            """Fail the way a rejected session.update would."""
            raise ConnectionResetError("session.update rejected")

    async def scenario() -> None:
        """Open a session whose configuration fails."""
        transport = RefusingTransport()
        factory = QwenAudioSessionFactory(CONFIG, connect=lambda config: _ready(transport))

        try:
            await factory.open("", [])
        except ConnectionResetError:
            pass
        else:
            raise AssertionError("expected the configuration failure to propagate")

        assert transport.closed is True

    asyncio.run(scenario())


async def _ready(transport: FakeTransport) -> FakeTransport:
    """Hand back an already-built transport, as a connect seam would."""
    return transport
