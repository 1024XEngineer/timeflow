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
        # Recorded apart from calls so the existing assertions on wording stay readable;
        # only the tests about pairing an utterance with its reply look at these.
        self.turn_ids: list[tuple[str, str | None]] = []

    async def heard(self, text: str, turn_id: str | None = None) -> None:
        """Record the user's transcript."""
        self.calls.append(("heard", text))
        self.turn_ids.append(("heard", turn_id))

    async def user_started_speaking(self) -> None:
        """Record that the vendor detected user speech."""
        self.calls.append(("user_started_speaking", None))

    async def spoke(self, text: str, turn_id: str | None = None) -> None:
        """Record the assistant's own words."""
        self.calls.append(("spoke", text))
        self.turn_ids.append(("spoke", turn_id))

    async def audio(self, data: bytes) -> None:
        """Record one decoded audio chunk."""
        self.calls.append(("audio", data))

    async def tool_requested(
        self, call_id: str, name: str, arguments: dict[str, Any], turn_id: str | None = None
    ) -> None:
        """Record a tool call request."""
        self.calls.append(("tool", (call_id, name, arguments)))
        self.turn_ids.append(("tool", turn_id))

    async def turn_completed(self) -> None:
        """Record that one reply on a continuous stream finished normally."""
        self.calls.append(("turn_completed", None))

    async def interrupted(self) -> None:
        """Record that the user spoke over an in-progress reply."""
        self.calls.append(("interrupted", None))

    async def failed(self, message: str) -> None:
        """Record a session failure."""
        self.calls.append(("failed", message))

    async def usage_reported(self, usage: dict[str, Any]) -> None:
        """Record one response's flattened usage and latency fields."""
        self.calls.append(("usage_reported", usage))

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


def test_configure_in_continuous_mode_sends_the_configured_history_window() -> None:
    async def scenario() -> None:
        config = QwenAudioConfig(
            api_key="key-abc",
            workspace_id="ws_001",
            model="qwen-audio-3.0-realtime-plus",
            max_history_turns=6,
            max_history_turns_push_to_talk=2,
        )
        transport = FakeTransport()

        await QwenAudioSession(transport, config, CONTINUOUS).configure("", [])

        assert transport.sent[0]["session"]["max_history_turns"] == 6

    asyncio.run(scenario())


def test_configure_in_push_to_talk_uses_the_smaller_history_window() -> None:
    """Push-to-talk is one request in, one reply out -- it needs less carried history
    than a continuous conversation does."""

    async def scenario() -> None:
        config = QwenAudioConfig(
            api_key="key-abc",
            workspace_id="ws_001",
            model="qwen-audio-3.0-realtime-plus",
            max_history_turns=6,
            max_history_turns_push_to_talk=2,
        )
        transport = FakeTransport()

        await QwenAudioSession(transport, config, PUSH_TO_TALK).configure("", [])

        assert transport.sent[0]["session"]["max_history_turns"] == 2

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
    """The output is written back as a conversation item immediately; the reply is only
    requested once the response that called the tool is itself done (see
    send_tool_result's docstring -- asking any earlier collides with that still-open
    response on the vendor's side).
    """

    async def scenario() -> None:
        """Send a tool result, then read back what was sent before and after settling."""
        transport = FakeTransport(_event("response.done"), _event("response.done"))
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)
        await session.finish_input()
        transport.sent.clear()

        await session.send_tool_result("call_1", '{"count":2}')

        assert transport.types() == ["conversation.item.create"]
        item = transport.sent[0]["item"]
        assert item == {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": '{"count":2}',
        }

        await session.pump(RecordingObserver())

        assert transport.types() == ["conversation.item.create", "response.create"]

    asyncio.run(scenario())


def test_a_tool_result_that_wants_no_reply_asks_for_none() -> None:
    """The output still lands in the conversation, but no further reply is requested.

    end_conversation's whole point is that there is nothing left to say -- the model spoke
    its goodbye in the response that called the tool. Asking anyway buys a second goodbye,
    which the vendor may start by cutting the first one short.
    """

    async def scenario() -> None:
        """Send a tool result that ends the conversation and read back what was sent."""
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)

        await session.send_tool_result("call_1", '{"status":"ok"}', respond=False)

        assert transport.types() == ["conversation.item.create"]
        # Written back regardless: the vendor's history has to stay complete for the
        # replies that follow on a session this one gets reused for.
        assert transport.sent[0]["item"]["call_id"] == "call_1"

    asyncio.run(scenario())


def test_a_suppressed_followup_settles_the_turn_instead_of_reading_past_it() -> None:
    """A tool that ends the conversation asks for no follow-up
    (send_tool_result(..., respond=False)). Its response.done is the turn's actual
    last event and must settle the pump immediately, not be treated the same as the
    "a follow-up is coming, keep waiting" case above -- doing that leaves nothing to
    stop the loop, so the next recv() reads past the end of the stream.
    """

    async def scenario() -> None:
        transport = FakeTransport(_event("response.done"))
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)
        observer = RecordingObserver()
        await session.finish_input()
        await session.send_tool_result("call-1", "{}", respond=False)

        await session.pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_continuous_suppressed_followup_reports_turn_completed() -> None:
    """Continuous-mode counterpart: a tool ending the conversation must still report
    turn_completed() so the caller (agent.py's _finish_reply/deliver_session_end)
    actually closes out the call, instead of being swallowed by the "a follow-up is
    coming" branch and leaving the call open.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)
        observer = RecordingObserver()
        await session.send_tool_result("call-1", "{}", respond=False)

        await session.pump(observer)

        assert observer.calls == [
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]

    asyncio.run(scenario())


def test_two_tool_calls_in_one_response_only_ask_for_a_single_followup() -> None:
    """A batch turn can call several tools before the response that requested them is
    done (e.g. a batch create/delete voice command). Each call must not eagerly ask
    for its own follow-up -- doing so, one per tool call, sends a second
    response.create while the vendor still considers the first response in progress,
    and it rejects the request outright ("Cannot create response while another
    response is in progress."). Exactly one follow-up should be asked for, once,
    after that response's own response.done.
    """

    async def scenario() -> None:
        transport = FakeTransport(_event("response.done"), _event("response.done"))
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)
        await session.finish_input()
        transport.sent.clear()

        await session.send_tool_result("call_1", '{"count":2}')
        await session.send_tool_result("call_2", '{"count":3}')

        # Both tool outputs are written back immediately; neither asks for a reply yet.
        assert transport.types() == ["conversation.item.create", "conversation.item.create"]

        await session.pump(RecordingObserver())

        # The follow-up is requested exactly once, after the tool-calling response's
        # own response.done -- not once per tool call.
        assert transport.types() == [
            "conversation.item.create",
            "conversation.item.create",
            "response.create",
        ]

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

    async def user_started_speaking(self) -> None:
        """Ignore detected user speech."""

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

    async def usage_reported(self, usage: dict[str, Any]) -> None:
        """Ignore the usage report."""


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
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第一句"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-1").decode()),
            _event("response.done"),
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第二句"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-2").decode()),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        # Explicit clock, not the real one: the second speech_started's own barge-in
        # check must land safely past the first reply's (near-instant) playable_until,
        # or this flakes depending on how fast the test happens to run.
        clock_reads = iter([0.0, 0.0, 0.0, 0.0, 1.0, 2.0, 2.0, 2.0, 2.0, 3.0])
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads)).pump(
            observer
        )

        assert observer.calls == [
            ("user_started_speaking", None),
            ("spoke", "第一句"),
            ("audio", b"pcm-1"),
            ("turn_completed", None),
            ("user_started_speaking", None),
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
            _event("input_audio_buffer.speech_started"),
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
            ("user_started_speaking", None),
            ("spoke", "半句"),
            ("user_started_speaking", None),
            ("interrupted", None),
            ("turn_completed", None),
            ("spoke", "新的回复"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_speech_started_still_cancels_after_generation_finishes_if_playback_is_not_done() -> None:
    """A barge-in landing after response.done still cancels, if the reply's own audio
    would still be playing on the phone.

    Found on a real device: the vendor generates audio faster than real time, so
    response.done only means the bytes were all sent -- not that the phone has finished
    sounding them out. The next turn's reply text was already on screen while the
    previous reply's audio was still audibly playing, because the old gate closed the
    moment generation ended rather than when playback would realistically be done.
    """

    async def scenario() -> None:
        # Five clock reads: response.created and the reply's first audio each stamp
        # a latency boundary, response.done estimates how long this reply's audio
        # takes to finish playing (~0.5s for the 24000 bytes below, 24kHz 16-bit
        # mono), then speech_started stamps itself and checks against that estimate
        # -- 0.1s later is still inside the playback window, so it is a real barge-in.
        # Leading pair (0.0, 0.0) is the reply's own opening speech_started -- legitimate,
        # nothing to interrupt yet (_playable_until starts at 0.0) -- so this stays a
        # harmless prefix ahead of the five reads the rest of the scenario already used.
        clock_reads = iter([0.0, 0.0, 0.0, 0.05, 0.05, 0.1, 0.1])
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"a" * 24000).decode()),
            _event("response.done"),
            _event("input_audio_buffer.speech_started"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads)).pump(
            observer
        )

        assert observer.kinds() == [
            "user_started_speaking",
            "audio",
            "turn_completed",
            "user_started_speaking",
            "interrupted",
            "failed",
        ]
        # Nothing was still generating, so there is nothing to tell the vendor to
        # abandon -- only the observer needs to hear about the barge-in.
        assert transport.types() == []

    asyncio.run(scenario())


def test_speech_started_does_not_cancel_once_the_reply_would_be_done_playing() -> None:
    """A barge-in arriving well after the reply's audio would have finished playing is
    not treated as a cancellation -- there is nothing left for it to interrupt.
    """

    async def scenario() -> None:
        # Five clock reads: created, first audio, done (playback estimate of ~0.5s for the
        # 24000 bytes below), then speech_started stamps itself and checks. 10s later is
        # far past the playback window, so nothing gets cancelled.
        # Leading pair (0.0, 0.0) is the reply's own opening speech_started -- legitimate,
        # nothing to interrupt yet (_playable_until starts at 0.0) -- so this stays a
        # harmless prefix ahead of the five reads the rest of the scenario already used.
        clock_reads = iter([0.0, 0.0, 0.0, 0.05, 0.05, 10.0, 10.0])
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"a" * 24000).decode()),
            _event("response.done"),
            _event("input_audio_buffer.speech_started"),
            _event("conversation.item.input_audio_transcription.completed", transcript="你好"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads)).pump(
            observer
        )

        assert observer.kinds() == [
            "user_started_speaking",
            "audio",
            "turn_completed",
            "user_started_speaking",
            "heard",
            "failed",
        ]

    asyncio.run(scenario())


def test_a_response_created_with_no_speech_or_followup_behind_it_is_canceled_on_sight() -> None:
    """The vendor has been seen to start a response on its own -- no new speech_started,
    no follow-up we asked for -- re-answering an already-settled query under a fresh
    reply_id. Cancelled before any of its text can reach the client.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="今天没有日程。"),
            _event("response.done"),
            _event("response.created"),  # unsolicited: no speech_started, no follow-up
            _event("response.audio_transcript.delta", delta="今天没有日程"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("user_started_speaking", None),
            ("spoke", "今天没有日程。"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_a_cancel_that_races_the_vendor_already_finishing_does_not_end_the_call() -> None:
    """Found in production: cancelling an unsolicited response.created can lose the race
    against the vendor finishing that same response a moment earlier on its own, which
    comes back as an "error" event ("Conversation has no active response") rather than
    silently succeeding. Treating every error as fatal hung up the whole call over what
    was actually a no-op -- this must be swallowed and the call carries on.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),  # unsolicited: no speech_started yet at all
            _event("error", error={"message": "Conversation has no active response."}),
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="真正的回复"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("user_started_speaking", None),
            ("spoke", "真正的回复"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_an_unrelated_error_after_a_cancel_still_ends_the_call() -> None:
    """The benign-race allowance is narrow: an error that is not the vendor saying
    there was nothing to cancel must still be treated as fatal, even right after a
    cancel_response() call.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"a" * 24000).decode()),
            _event("input_audio_buffer.speech_started"),  # barge-in: cancels the reply
            _event("error", error={"message": "internal server error"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls[-1] == ("failed", "internal server error")
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_a_response_done_between_the_cancel_and_its_error_does_not_end_the_call() -> None:
    """The benign cancel race, in the order it actually arrives from the vendor.

    The vendor having already finished that response on its own is the very thing that
    makes our cancel a no-op, so its response.done lands *between* the response.cancel
    and the error saying there was nothing to cancel. An allowance that only covers the
    single next event is spent on that response.done, and the call is then hung up over
    exactly the race the allowance was added for.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),  # unsolicited: no speech_started, no follow-up
            _event("response.done"),  # the vendor had already finished it on its own
            _event("error", error={"message": "Conversation has no active response."}),
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="真正的回复"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.calls == [
            ("turn_completed", None),
            ("user_started_speaking", None),
            ("spoke", "真正的回复"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_a_reused_session_does_not_inherit_the_previous_stream_s_expectations() -> None:
    """A held session serves the next call too, so its per-stream state starts over.

    _expecting_response left true by the call that just ended would wave through the
    first spontaneous response of the next one -- the duplicate reply this guard exists
    to catch, slipping past on exactly the turn nobody is watching for it.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            # First call: a reply we were legitimately waiting on, cut short.
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("error", error={"message": "stream ended"}),
            # Second call on the same session: the vendor speaks up unprompted.
            _event("response.created"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)

        await session.pump(RecordingObserver())
        second = RecordingObserver()
        await session.pump(second)

        assert second.calls == [("failed", "stream ended")]
        assert transport.types() == ["response.cancel"]

    asyncio.run(scenario())


def test_a_reused_session_does_not_inherit_the_previous_reply_s_playback_estimate() -> None:
    """The same reset, for the audio a previous call left counted as still playing.

    Within one call, `suppressed` shadows a stale playback estimate; across calls
    nothing does, and the next call's opening speech_started gets reported as a barge-in
    on a reply from the call before it -- a voice.tts.canceled the moment a fresh call
    starts, over audio nobody is hearing.
    """

    async def scenario() -> None:
        # First call: speech_started stamps and compares, response.created, first audio,
        # then response.done estimates 0.5s of playback for the 24000 bytes below. The
        # second call's speech_started stamps and compares 0.1s later -- inside that
        # estimate, which is what makes the leak visible.
        clock_reads = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1])
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"a" * 24000).decode()),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
            # Second call on the same session.
            _event("input_audio_buffer.speech_started"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads))

        await session.pump(RecordingObserver())
        second = RecordingObserver()
        await session.pump(second)

        assert second.kinds() == ["user_started_speaking", "failed"]

    asyncio.run(scenario())


def test_a_reply_and_its_late_transcript_report_the_same_utterance_id() -> None:
    """Captured from a real call: the vendor stamps the user's audio with an item id and
    puts it on the transcript, which routinely lands after the reply it belongs to has
    already started streaming. Reporting that id on both sides is what lets the client
    pair them without guessing from arrival order.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started", item_id="item_user_1"),
            _event("input_audio_buffer.committed", item_id="item_user_1"),
            _event("response.created"),
            _event("response.audio_transcript.delta", delta="明天"),
            # The real ordering: the transcript arrives mid-reply, not before it.
            _event(
                "conversation.item.input_audio_transcription.completed",
                item_id="item_user_1",
                transcript="明天我要看电影。",
            ),
            _event("response.audio_transcript.done", transcript="明天看电影，具体几点去？"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.turn_ids == [
            ("spoke", "item_user_1"),
            ("heard", "item_user_1"),
            ("spoke", "item_user_1"),
        ]

    asyncio.run(scenario())


def test_a_late_transcript_reports_its_own_utterance_not_the_one_now_running() -> None:
    """A transcript carries its own item_id, so one that arrives after the user has
    already started the next utterance still names the turn it actually transcribes.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started", item_id="item_user_1"),
            _event("input_audio_buffer.committed", item_id="item_user_1"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第一条回复"),
            _event("response.done"),
            # The next utterance is already under way when turn 1's transcript lands.
            _event("input_audio_buffer.speech_started", item_id="item_user_2"),
            _event(
                "conversation.item.input_audio_transcription.completed",
                item_id="item_user_1",
                transcript="第一句话",
            ),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert observer.turn_ids == [("spoke", "item_user_1"), ("heard", "item_user_1")]
        assert observer.calls[-2] == ("heard", "第一句话")

    asyncio.run(scenario())


def test_a_tool_call_names_the_utterance_it_is_answering() -> None:
    """A tool call happens before this reply has said anything, so the id has to come
    from the session rather than from whatever the previous reply left behind -- a
    question raised by the tool would otherwise be filed under the previous turn.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started", item_id="item_user_1"),
            _event("input_audio_buffer.committed", item_id="item_user_1"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="第一条回复"),
            _event("response.done"),
            _event("input_audio_buffer.speech_started", item_id="item_user_2"),
            _event("input_audio_buffer.committed", item_id="item_user_2"),
            _event("response.created"),
            _event(
                "response.function_call_arguments.done",
                call_id="call_1",
                name="schedule_create",
                arguments="{}",
            ),
            _event("error", error={"message": "stream ended"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS).pump(observer)

        assert ("tool", "item_user_2") in observer.turn_ids


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


def test_continuous_first_response_done_after_a_tool_call_does_not_end_the_turn() -> None:
    """A tool call's response.create (send_tool_result) keeps the pump from settling early.

    Mirrors push-to-talk's test_first_response_done_does_not_end_a_tool_extended_turn:
    the first response.done belongs to the response that ran the tool, not the one
    carrying the model's actual reply, so it must not report turn_completed on its own
    -- a caller like end_conversation would otherwise hang up before the model even
    started its real (possibly farewell) reply.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.done"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="好的，再见"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)
        observer = RecordingObserver()
        await session.send_tool_result("call-1", "{}")

        await session.pump(observer)

        assert observer.calls == [
            ("spoke", "好的，再见"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]

    asyncio.run(scenario())


def test_continuous_two_tool_calls_in_one_response_only_ask_for_a_single_followup() -> None:
    """Continuous mode's version of test_two_tool_calls_in_one_response_only_ask_for_a
    _single_followup above: a batch voice command (e.g. "create three schedules")
    can make the model call several tools inside one response before that response
    is done. Asking for a follow-up per call, instead of once the response settles,
    is what force-ends the whole conversation in production -- the vendor's
    rejection is reported through failed(), which continuous mode treats as the
    call having to hang up.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.done"),
            _event("response.created"),
            _event("response.audio_transcript.done", transcript="好的，都办好了"),
            _event("response.done"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)
        observer = RecordingObserver()
        await session.send_tool_result("call-1", "{}")
        await session.send_tool_result("call-2", "{}")

        await session.pump(observer)

        assert observer.calls == [
            ("spoke", "好的，都办好了"),
            ("turn_completed", None),
            ("failed", "stream ended"),
        ]
        assert transport.types().count("response.create") == 1

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

        assert observer.calls == [
            ("user_started_speaking", None),
            ("heard", "你好"),
            ("failed", "stream ended"),
        ]
        assert transport.types() == []

    asyncio.run(scenario())


def test_cancel_response_sends_response_cancel_when_a_reply_is_in_flight() -> None:
    """cancel_response() tells the vendor to stop a reply that never finished on its own.

    Mirrors what agent.py does when the microphone closes mid-reply: the pump task
    gets cancelled by the caller before it can naturally observe response.done, so
    cancel_response() must read the session's own responding state rather than
    depending on the pump loop having settled it.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.created"),
            _event("response.audio_transcript.delta", delta="你好"),
            _event("error", error={"message": "stream ended"}),
        )
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)
        observer = RecordingObserver()

        await session.pump(observer)
        await session.cancel_response()

        assert transport.types()[-1] == "response.cancel"

    asyncio.run(scenario())


def test_cancel_response_is_a_no_op_when_nothing_is_responding() -> None:
    """Calling cancel_response() with no reply in flight sends nothing to the vendor.

    A blind response.cancel would risk drawing a vendor error event with nothing to
    cancel -- and since the session is reused, that stray frame would be read by the
    next turn's pump as if it were about that turn's own stream.
    """

    async def scenario() -> None:
        transport = FakeTransport()
        session = QwenAudioSession(transport, CONFIG, CONTINUOUS)

        await session.cancel_response()

        assert transport.sent == []

    asyncio.run(scenario())


def _usage_event(**overrides: Any) -> str:
    """Build a response.done frame carrying the vendor's real usage shape."""
    usage: dict[str, Any] = {
        "total_tokens": 100,
        "input_tokens": 80,
        "output_tokens": 20,
        "input_tokens_details": {"text_tokens": 60, "audio_tokens": 20},
        "output_tokens_details": {"text_tokens": 5, "audio_tokens": 15},
    }
    usage.update(overrides)
    return _event("response.done", response={"status": "completed", "usage": usage})


def test_push_to_talk_reports_usage_with_no_latency_when_no_response_created_arrived() -> None:
    """A response.done with usage but nothing to time against reports latency as None.

    Push-to-talk's own response.created handling stamps _response_started_at, but a
    reply short enough (or a vendor quirk) can settle without ever emitting one -- the
    flattened usage must still reach the observer, just with every latency field absent
    rather than computed against a missing start time.
    """

    async def scenario() -> None:
        transport = FakeTransport(_usage_event())
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [
            (
                "usage_reported",
                {
                    "total_tokens": 100,
                    "input_tokens": 80,
                    "output_tokens": 20,
                    "input_text_tokens": 60,
                    "input_audio_tokens": 20,
                    "output_text_tokens": 5,
                    "output_audio_tokens": 15,
                    "latency_vad_ms": None,
                    "latency_first_audio_ms": None,
                    "latency_response_ms": None,
                },
            )
        ]

    asyncio.run(scenario())


def test_continuous_reports_usage_with_computed_latency() -> None:
    """A full continuous turn reports vad/first-audio/response latency alongside usage.

    Exercises the non-None branch of _latency_report(): response.created stamps the
    response start, input_audio_buffer.speech_started stamps the VAD boundary before
    it, and the first audio.delta stamps first_audio -- all three land in the usage
    payload once response.done arrives.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm").decode()),
            _usage_event(),
            _event("error", error={"message": "stream ended"}),
        )
        # Reads in call order: speech_started stamps _speech_started_at, then the same
        # branch's barge-in check reads the clock again (self._responding is still
        # False at that point, so Python evaluates the "or"'s second operand);
        # response.created stamps _response_started_at; the first audio.delta stamps
        # _first_audio_at; response.done's own latency report reads the clock once for
        # latency_response_ms; then response.done's playable_until estimate reads it
        # once more.
        clock_reads = iter([0.0, 0.0, 1.0, 1.2, 1.5, 1.5])
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads)).pump(
            observer
        )

        usage_calls = [call for call in observer.calls if call[0] == "usage_reported"]
        assert len(usage_calls) == 1
        usage = usage_calls[0][1]
        assert usage["latency_vad_ms"] == 1000.0
        assert usage["latency_first_audio_ms"] == 200.0
        assert usage["latency_response_ms"] == 500.0

    asyncio.run(scenario())


def test_a_response_done_without_a_completed_status_reports_no_usage() -> None:
    """A cancelled or failed response carries no usage block; nothing is reported."""

    async def scenario() -> None:
        transport = FakeTransport(
            _event("response.done", response={"status": "cancelled"}),
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_a_second_audio_delta_does_not_re_stamp_first_audio_time() -> None:
    """Only the first audio.delta in a reply sets _first_audio_at; later chunks in the
    same reply must not overwrite it once it is already set.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event("input_audio_buffer.speech_started"),
            _event("response.created"),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-1").decode()),
            _event("response.audio.delta", delta=base64.b64encode(b"pcm-2").decode()),
            _usage_event(),
            _event("error", error={"message": "stream ended"}),
        )
        # Leading pair (0.0, 0.0) is the reply's own opening speech_started (legitimate,
        # nothing to interrupt yet). Then: created, first delta stamps _first_audio_at,
        # second delta's guard reads nothing further (short-circuited), response.done's
        # own latency report, then its playable_until estimate.
        clock_reads = iter([0.0, 0.0, 0.0, 0.2, 0.5, 0.5])
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, CONTINUOUS, clock=lambda: next(clock_reads)).pump(
            observer
        )

        usage = next(call[1] for call in observer.calls if call[0] == "usage_reported")
        assert usage["latency_first_audio_ms"] == 200.0
        assert observer.calls[0] == ("user_started_speaking", None)
        assert observer.calls[1] == ("audio", b"pcm-1")
        assert observer.calls[2] == ("audio", b"pcm-2")

    asyncio.run(scenario())


def test_a_second_open_response_after_settling_one_keeps_the_pump_running() -> None:
    """_open_responses can exceed 1 when a caller starts a second response.create
    before the first is done (e.g. finish_input() called again on an already-open
    turn) -- the first response.done must not end the pump while one is still open.
    """

    async def scenario() -> None:
        transport = FakeTransport(_event("response.done"), _event("response.done"))
        session = QwenAudioSession(transport, CONFIG, PUSH_TO_TALK)
        await session.finish_input()
        await session.finish_input()
        observer = RecordingObserver()

        await session.pump(observer)

        assert observer.calls == []

    asyncio.run(scenario())


def test_usage_without_token_detail_breakdowns_reports_none_for_them() -> None:
    """A usage block missing the per-modality detail objects still reports the totals.

    Nothing in the protocol guarantees input_tokens_details/output_tokens_details are
    always present; _parse_usage must degrade to None for the four detail fields
    rather than raising.
    """

    async def scenario() -> None:
        transport = FakeTransport(
            _event(
                "response.done",
                response={
                    "status": "completed",
                    "usage": {"total_tokens": 10, "input_tokens": 8, "output_tokens": 2},
                },
            )
        )
        observer = RecordingObserver()

        await QwenAudioSession(transport, CONFIG, PUSH_TO_TALK).pump(observer)

        assert observer.calls == [
            (
                "usage_reported",
                {
                    "total_tokens": 10,
                    "input_tokens": 8,
                    "output_tokens": 2,
                    "input_text_tokens": None,
                    "input_audio_tokens": None,
                    "output_text_tokens": None,
                    "output_audio_tokens": None,
                    "latency_vad_ms": None,
                    "latency_first_audio_ms": None,
                    "latency_response_ms": None,
                },
            )
        ]

    asyncio.run(scenario())
