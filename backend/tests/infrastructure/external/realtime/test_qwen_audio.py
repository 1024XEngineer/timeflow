"""Translating the vendor's realtime wire format, with a fake transport."""

import asyncio
import base64
import json
from typing import Any

from timeflow.infrastructure.external.realtime.qwen_audio import (
    CONTINUOUS,
    PUSH_TO_TALK,
    Observer,
    QwenAudioConfig,
    QwenAudioSession,
    QwenAudioSessionFactory,
    turn_detection_for,
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

    def __init__(self, *inbound: str | bytes) -> None:
        """Queue the frames the server will send, in order."""
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        self._inbound = list(inbound)

    async def send(self, message: str) -> None:
        """Record one client event."""
        self.sent.append(json.loads(message))

    async def recv(self) -> str | bytes:
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

    async def turn_completed(self) -> None:
        """Record that one reply on a continuous stream finished normally."""
        self.calls.append(("turn_completed", None))

    async def interrupted(self) -> None:
        """Record that the user spoke over an in-progress reply."""
        self.calls.append(("interrupted", None))

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


def test_turn_detection_for_push_to_talk_is_none() -> None:
    """Push-to-talk never gets a vendor turn_detection, regardless of config."""
    assert turn_detection_for(PUSH_TO_TALK, CONFIG) is None


def test_turn_detection_for_continuous_defaults_to_smart_turn() -> None:
    """CONFIG's default turn_detection is smart_turn, so continuous mode picks it up."""
    assert turn_detection_for(CONTINUOUS, CONFIG) == {"type": "smart_turn"}


def test_turn_detection_for_continuous_can_use_server_vad_with_its_own_params() -> None:
    """server_vad carries its own threshold and silence duration, not smart_turn's."""
    config = QwenAudioConfig(
        api_key="key-abc",
        workspace_id="ws_001",
        model="qwen-audio-3.0-realtime-plus",
        turn_detection="server_vad",
        vad_threshold=0.3,
        vad_silence_duration_ms=500,
    )

    assert turn_detection_for(CONTINUOUS, config) == {
        "type": "server_vad",
        "threshold": 0.3,
        "silence_duration_ms": 500,
    }


def test_configure_puts_the_session_in_push_to_talk() -> None:
    """turn_detection is null, because our own protocol owns turn boundaries.

    Letting the model decide when a turn ended would race voice.stream.end: it would
    answer before the client said it had finished speaking.
    """

    async def scenario() -> None:
        """Configure a session and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)

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


def test_empty_optional_configuration_is_omitted_from_the_vendor_event() -> None:
    async def scenario() -> None:
        transport = FakeTransport()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).configure("", [])

        session = transport.sent[0]["session"]
        assert "instructions" not in session
        assert "tools" not in session

    asyncio.run(scenario())


def test_audio_is_base64_encoded_on_the_way_out() -> None:
    """The vendor takes audio as base64 inside a JSON event, not as binary frames."""

    async def scenario() -> None:
        """Send one chunk and inspect the frame."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)

        await session.send_audio(b"\x01\x02\x03")

        assert transport.types() == ["input_audio_buffer.append"]
        assert base64.b64decode(transport.sent[0]["audio"]) == b"\x01\x02\x03"

    asyncio.run(scenario())


def test_finishing_input_commits_then_asks_for_a_reply() -> None:
    """Both events are needed and in this order; commit alone produces no answer."""

    async def scenario() -> None:
        """Finish the input and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)

        await session.finish_input()

        assert transport.types() == ["input_audio_buffer.commit", "response.create"]

    asyncio.run(scenario())


def test_configure_in_continuous_mode_uses_the_configured_turn_detection() -> None:
    """Continuous mode's turn_detection comes from config, not push-to-talk's null."""

    async def scenario() -> None:
        transport = FakeTransport()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).configure("", [])

        assert transport.sent[0]["session"]["turn_detection"] == {"type": "smart_turn"}

    asyncio.run(scenario())


def test_finish_input_in_continuous_mode_sends_nothing() -> None:
    """The vendor's own VAD ends a continuous turn; committing here would race it.

    Sending commit/response.create anyway would double up the reply once the vendor's
    own turn_detection also fires.
    """

    async def scenario() -> None:
        transport = FakeTransport()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).finish_input()

        assert transport.sent == []

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

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
            QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(RecordingObserver()), timeout=1.0
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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

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
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)

        await session.send_tool_result("call_1", '{"count":2}')

        assert transport.types() == ["conversation.item.create", "response.create"]
        item = transport.sent[0]["item"]
        assert item == {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": '{"count":2}',
        }

    asyncio.run(scenario())


def test_first_response_done_does_not_end_a_tool_extended_turn() -> None:
    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.done"),
            _event("response.audio_transcript.done", transcript="工具执行完成"),
            _event("response.done"),
        )
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)
        observer = RecordingObserver()
        await session.finish_input()
        await session.send_tool_result("call-1", "{}")

        await session.pump(observer)

        assert observer.calls == [("spoke", "工具执行完成")]

    asyncio.run(scenario())


def test_tool_arguments_must_be_parseable_when_present() -> None:
    async def scenario() -> None:
        accepted = RecordingObserver()
        await QwenAudioSession(
            FakeTransport(
                _event(
                    "response.function_call_arguments.done",
                    call_id="call-1",
                    name="query",
                    arguments="[]",
                ),
                _event("response.done"),
            ),
            CONFIG,
            PUSH_TO_TALK,
        ).pump(accepted)
        assert accepted.calls == [("tool", ("call-1", "query", {}))]

        malformed = RecordingObserver()
        await QwenAudioSession(
            FakeTransport(
                _event(
                    "response.function_call_arguments.done",
                    call_id="call-1",
                    name="query",
                    arguments="{",
                )
            ),
            CONFIG,
            PUSH_TO_TALK,
        ).pump(malformed)
        assert malformed.kinds() == ["failed"]

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [("audio", b"good")]

    asyncio.run(scenario())


def test_empty_and_non_string_audio_deltas_are_dropped_not_fatal() -> None:
    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.audio.delta", delta=""),
            _event("response.audio.delta", delta=123),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_a_vendor_error_event_fails_the_turn_with_its_message() -> None:
    """The vendor's own message is surfaced rather than replaced by a generic one."""

    async def scenario() -> None:
        """Replay an error event."""
        transport = FakeTransport(_event("error", error={"message": "quota exceeded"}))
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [("failed", "quota exceeded")]

    asyncio.run(scenario())


def test_a_vendor_error_without_a_message_uses_the_stable_fallback() -> None:
    async def scenario() -> None:
        observer = RecordingObserver()

        await QwenAudioSession(FakeTransport(_event("error", error={})), CONFIG, PUSH_TO_TALK).pump(
            observer
        )

        assert observer.calls == [("failed", "realtime session reported an error")]

    asyncio.run(scenario())


def test_binary_frames_are_ignored_but_malformed_text_frames_fail_the_turn() -> None:
    async def scenario() -> None:
        binary_observer = RecordingObserver()
        await QwenAudioSession(
            FakeTransport(b"vendor-binary", _event("response.done")), CONFIG, PUSH_TO_TALK
        ).pump(binary_observer)
        assert binary_observer.calls == []

        for frame, expected in (("not-json", "non-JSON"), ("[]", "non-object")):
            observer = RecordingObserver()
            await QwenAudioSession(FakeTransport(frame), CONFIG, PUSH_TO_TALK).pump(observer)
            assert observer.calls == [("failed", f"realtime session sent a {expected} frame")]

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

        await QwenAudioSession(BrokenTransport(), CONFIG, PUSH_TO_TALK).pump(observer)

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

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
        session = await factory.open("你是日程助手", [], PUSH_TO_TALK)

        assert isinstance(session, QwenAudioSession)
        assert transport.types() == ["session.update"]
        assert transport.sent[0]["session"]["turn_detection"] is None

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

        await QwenAudioSession(RefusesToClose(), CONFIG, PUSH_TO_TALK).close()

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

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

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [("spoke", "好")]

    asyncio.run(scenario())


def test_the_adapter_satisfies_the_dialogue_layer_s_ports() -> None:
    """The two declarations of the seam are the same shape.

    Neither side imports the other, so nothing else would notice one of them drifting.
    mypy rejects these assignments the moment they stop matching; no call site needed.
    """
    session: RealtimeSession = QwenAudioSession(FakeTransport(), CONFIG, PUSH_TO_TALK)
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

    async def turn_completed(self) -> None:
        """Ignore the completed reply."""

    async def interrupted(self) -> None:
        """Ignore the interruption."""

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
            await factory.open("", [], PUSH_TO_TALK)
        except ConnectionResetError:
            pass
        else:
            raise AssertionError("expected the configuration failure to propagate")

        assert transport.closed is True

    asyncio.run(scenario())


async def _ready(transport: FakeTransport) -> FakeTransport:
    """Hand back an already-built transport, as a connect seam would."""
    return transport


class BinaryTransport(FakeTransport):
    """A transport that can also hand back a binary frame."""

    def __init__(self, *inbound: Any) -> None:
        """Queue frames that may be bytes as well as text."""
        super().__init__()
        self._frames = list(inbound)

    async def recv(self) -> Any:
        """Return the next frame, text or binary."""
        if not self._frames:
            raise AssertionError("the pump read past the end of the scripted turn")
        return self._frames.pop(0)


def test_a_binary_frame_is_skipped_and_the_turn_carries_on() -> None:
    """The vendor sends JSON text; a binary frame is ignored rather than fatal."""

    async def scenario() -> None:
        transport = BinaryTransport(b"\x00\x01", _event("response.done"))
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_a_frame_that_is_not_json_fails_the_turn() -> None:
    """Unparsable text ends the turn with a reason rather than raising."""

    async def scenario() -> None:
        transport = FakeTransport("not json at all")
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.kinds() == ["failed"]
        assert "non-JSON" in observer.calls[0][1]

    asyncio.run(scenario())


def test_a_json_frame_that_is_not_an_object_fails_the_turn() -> None:
    """A bare array is valid JSON but not an event, so the turn ends."""

    async def scenario() -> None:
        transport = FakeTransport(json.dumps([1, 2, 3]))
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.kinds() == ["failed"]
        assert "non-object" in observer.calls[0][1]

    asyncio.run(scenario())


def test_an_empty_audio_delta_reaches_nobody() -> None:
    """A delta carrying no audio is dropped rather than pushed on as silence."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.audio.delta", delta=""),
            _event("response.audio.delta"),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_a_tool_call_with_unparsable_arguments_fails_the_turn() -> None:
    """Arguments that are not JSON cannot be acted on, so the turn ends with a reason."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="schedule_create",
                arguments="{not json",
            )
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.kinds() == ["failed"]

    asyncio.run(scenario())


def test_a_tool_call_whose_arguments_are_not_an_object_runs_with_none() -> None:
    """Valid JSON that is not an object leaves the tool with no arguments, not a crash."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="schedule_query",
                arguments="[1, 2]",
            ),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls[0] == ("tool", ("call_1", "schedule_query", {}))

    asyncio.run(scenario())


def test_an_error_event_with_no_message_still_reads_as_a_failure() -> None:
    """A vendor error without a message gets a stand-in rather than an empty reason."""

    async def scenario() -> None:
        transport = FakeTransport(_event("error"))
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [("failed", "realtime session reported an error")]

    asyncio.run(scenario())


def test_a_tool_call_with_no_arguments_field_runs_with_none() -> None:
    """A tool call event that omits arguments entirely defaults to an empty dict."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="list_schedules",
            ),
            _event("response.done"),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls[0] == ("tool", ("call_1", "list_schedules", {}))

    asyncio.run(scenario())


def test_continuous_pump_reports_multiple_replies_without_returning() -> None:
    """turn_completed fires after each response.done, and the pump keeps listening.

    Unlike push-to-talk, response.done does not end a continuous pump: the vendor may
    still start another reply on the same stream, so the loop only stops when told to.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第一句"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-1").decode()),
            _event("response.done"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第二句"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-2").decode()),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("spoke", "第一句"),
            ("audio", b"pcm-1"),
            ("turn_completed", None),
            ("spoke", "第二句"),
            ("audio", b"pcm-2"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]

    asyncio.run(scenario())


def test_continuous_pump_cancels_and_reports_an_interruption() -> None:
    """speech_started while a reply is in flight cancels it and tells the observer.

    The vendor may still emit a few queued deltas for the cancelled reply before it
    catches up; those must be dropped, not reported as if they belonged to the next one.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.audio_transcript.delta", delta="半句"),
            _event("input_audio_buffer.speech_started"),
            _event("response.audio_transcript.delta", delta="不该出现的"),
            _event("response.audio.delta", delta=base64.b64encode(b"stale").decode()),
            _event("response.done"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="新的回复"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("spoke", "半句"),
            ("interrupted", None),
            ("turn_completed", None),
            ("spoke", "新的回复"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_continuous_pump_reports_tool_calls_and_a_bad_one_ends_the_stream() -> None:
    """Continuous mode reports tool calls the same way push-to-talk does."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="list_schedules",
                arguments='{"range":"today"}',
            ),
            _event(
                "response.function_call_arguments.done",
                name="list_schedules",
                arguments="{}",
            ),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("tool", ("call_1", "list_schedules", {"range": "today"})),
            ("failed", "realtime session sent an unusable tool call"),
        ]

    asyncio.run(scenario())


def test_continuous_pump_stops_when_a_frame_cannot_be_parsed() -> None:
    """A malformed frame ends a continuous stream the same way it ends push-to-talk."""

    async def scenario() -> None:
        transport = FakeTransport("not json at all")
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.kinds() == ["failed"]
        assert "non-JSON" in observer.calls[0][1]

    asyncio.run(scenario())


def test_continuous_pump_ignores_empty_transcript_and_audio_deltas() -> None:
    """Empty or non-advancing content is silently dropped rather than reported as new."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.audio_transcript.done", transcript=""),
            _event("response.audio.delta", delta=""),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [("failed", "stream ended")]

    asyncio.run(scenario())


def test_continuous_pump_ignores_speech_started_before_any_reply() -> None:
    """speech_started with nothing in flight is the user starting to talk, not a barge-in."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("conversation.item.input_audio_transcription.completed", transcript="你好"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [("heard", "你好"), ("failed", "stream ended")]
        assert transport.types() == []

    asyncio.run(scenario())
