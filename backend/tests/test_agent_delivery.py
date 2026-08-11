"""How the two result messages reach the wire, when things go wrong or happen at once."""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import pytest

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.gateway.websocket.messages.dialogue import QUESTION_KINDS
from timeflow.intelligence.ports import (
    AudioReply,
    CommandResult,
    DialogueQuestion,
    ReplyText,
    Transcript,
)

SESSION_ID = "ws_session_test"


@dataclass(frozen=True, slots=True)
class _Identity:
    """Identifiers of the stream a result answers."""

    session_id: str = SESSION_ID
    stream_id: str = "stream_test"
    conversation_id: str = "conversation_test"
    request_id: str | None = "req_voice_001"


class RecordingConnection:
    """A stand-in socket that records the frames written to it."""

    def __init__(self) -> None:
        """Start with nothing sent."""
        self.frames: list[dict[str, Any]] = []

    async def send_json(self, data: Any) -> None:
        """Record one JSON frame."""
        self.frames.append(data)

    async def send_bytes(self, data: bytes) -> None:
        """Record one binary frame as a marker, so audio shows up in the frame order."""
        self.frames.append({"type": "audio"})


def _transcript(tag: str) -> Transcript:
    """Build a transcript tagged so its message can be told apart."""
    return Transcript(text=tag, language="zh", duration_ms=10)


def _result(tag: str) -> CommandResult:
    """Build a command result tagged so its message can be told apart."""
    return CommandResult(
        message_id=tag,
        operation="create_schedule",
        status="applied",
        schedule={"id": tag},
    )


def test_deliver_transcript_sends_voice_asr_completed() -> None:
    """The transcript goes out on its own, carrying the stream's identifiers."""

    async def scenario() -> None:
        """Deliver only a transcript to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_transcript(
            _transcript("明天下午三点在203开会"), _Identity()
        )

        assert len(connection.frames) == 1
        frame = connection.frames[0]
        assert frame["type"] == "voice.asr.completed"
        assert frame["request_id"] == "req_voice_001"
        assert frame["conversation_id"] == "conversation_test"
        assert frame["payload"]["transcript"] == "明天下午三点在203开会"

    asyncio.run(scenario())


def test_deliver_result_sends_voice_command_result() -> None:
    """The command result goes out on its own, without needing a transcript first."""

    async def scenario() -> None:
        """Deliver only a command result to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_result(_result("msg_a"), _Identity())

        assert len(connection.frames) == 1
        frame = connection.frames[0]
        assert frame["type"] == "voice.command.result"
        assert frame["message_id"] == "msg_a"
        assert frame["conversation_id"] == "conversation_test"
        assert frame["payload"]["operation"] == "create_schedule"

    asyncio.run(scenario())


def test_the_two_messages_are_independent_calls() -> None:
    """Each message is one call, so the caller decides when each goes out."""

    async def scenario() -> None:
        """Send the transcript, then the result, as two separate calls."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        await sink.deliver_transcript(_transcript("msg_a"), _Identity())
        assert [frame["type"] for frame in connection.frames] == ["voice.asr.completed"]

        await sink.deliver_result(_result("msg_a"), _Identity())
        assert [frame["type"] for frame in connection.frames] == [
            "voice.asr.completed",
            "voice.command.result",
        ]

    asyncio.run(scenario())


def test_delivering_to_a_gone_session_sends_nothing() -> None:
    """A result for a session that has closed is dropped rather than raising."""

    async def scenario() -> None:
        """Deliver both messages for a session nobody registered."""
        connections = ConnectionManager()
        sink = WebSocketResultSink(connections)

        await sink.deliver_transcript(_transcript("msg_a"), _Identity())
        await sink.deliver_result(_result("msg_a"), _Identity())

    asyncio.run(scenario())


def test_a_session_that_dies_after_the_transcript_gets_no_result() -> None:
    """A connection that leaves after the first message is never written to again."""

    async def scenario() -> None:
        """Let the connection unregister itself once the first frame lands."""
        connections = ConnectionManager()

        class DiesAfterFirstFrame(RecordingConnection):
            """A socket that drops out of the registry after one frame."""

            async def send_json(self, data: Any) -> None:
                """Record the frame, then leave the registry."""
                await super().send_json(data)
                connections.unregister(SESSION_ID, self)

        connection = DiesAfterFirstFrame()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        await sink.deliver_transcript(_transcript("msg_a"), _Identity())
        await sink.deliver_result(_result("msg_a"), _Identity())

        assert [frame["type"] for frame in connection.frames] == ["voice.asr.completed"]

    asyncio.run(scenario())


def test_a_result_follows_a_reconnect_that_lands_before_it_is_written() -> None:
    """A result addressed to a replaced connection is not written to the stale socket."""

    async def scenario() -> None:
        """Hold the write lock, start delivery, reconnect, then let delivery proceed."""
        connections = ConnectionManager()
        stale = RecordingConnection()
        live = RecordingConnection()
        connections.register(SESSION_ID, stale)

        async with connections.lock_for(SESSION_ID):
            delivery = asyncio.create_task(
                WebSocketResultSink(connections).deliver_result(_result("msg_a"), _Identity())
            )
            await asyncio.sleep(0)
            connections.register(SESSION_ID, live)

        await delivery

        assert stale.frames == []

    asyncio.run(scenario())


def test_results_for_different_sessions_stay_apart() -> None:
    """Two sessions each receive only their own result."""

    async def scenario() -> None:
        """Deliver one result per session, concurrently."""
        connections = ConnectionManager()
        first = RecordingConnection()
        second = RecordingConnection()
        connections.register("ws_session_first", first)
        connections.register("ws_session_second", second)
        sink = WebSocketResultSink(connections)

        await asyncio.gather(
            sink.deliver_result(_result("msg_first"), _Identity(session_id="ws_session_first")),
            sink.deliver_result(_result("msg_second"), _Identity(session_id="ws_session_second")),
        )

        assert [frame["message_id"] for frame in first.frames] == ["msg_first"]
        assert [frame["message_id"] for frame in second.frames] == ["msg_second"]

    asyncio.run(scenario())


def _reply() -> AudioReply:
    """Build a spoken reply matching what the realtime model emits."""
    return AudioReply(
        audio_id="audio_001",
        audio_format="pcm",
        sample_rate_hz=24000,
        purpose="command_result",
        speech_text="好，明天下午三点在203的会已经记下了",
    )


async def _chunks(*payloads: bytes) -> AsyncIterator[bytes]:
    """Yield the given chunks with no delay."""
    for payload in payloads:
        yield payload


def test_deliver_audio_translates_the_reply_into_voice_tts_start() -> None:
    """The reply description becomes a voice.tts.start carrying the stream's identifiers."""

    async def scenario() -> None:
        """Speak a one-chunk reply to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(_reply(), _chunks(b"aa"), _Identity())

        start = connection.frames[0]
        assert start["type"] == "voice.tts.start"
        assert start["conversation_id"] == "conversation_test"
        assert start["audio_id"] == "audio_001"
        assert start["payload"] == {
            "format": "pcm",
            "sample_rate_hz": 24000,
            "purpose": "command_result",
            "speech_text": "好，明天下午三点在203的会已经记下了",
            "schedule_id": None,
            "audio_version": None,
        }
        assert "ok" not in start

    asyncio.run(scenario())


def test_the_reply_text_arrives_before_any_audio() -> None:
    """speech_text rides on the start message, so the words are known before the sound."""

    async def scenario() -> None:
        """Speak a reply and read the frame order."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(
            _reply(), _chunks(b"aa", b"bb"), _Identity()
        )

        assert [frame["type"] for frame in connection.frames] == [
            "voice.tts.start",
            "audio",
            "audio",
            "voice.tts.end",
        ]

    asyncio.run(scenario())


def test_speaking_to_a_gone_session_sends_nothing() -> None:
    """A reply for a session that has closed is dropped rather than raising."""

    async def scenario() -> None:
        """Speak to a session nobody registered."""
        connections = ConnectionManager()

        await WebSocketResultSink(connections).deliver_audio(_reply(), _chunks(b"aa"), _Identity())

    asyncio.run(scenario())


def test_deliver_reply_text_sends_voice_dialogue_reply() -> None:
    """The reply's wording goes out on its own message, before any audio exists."""

    async def scenario() -> None:
        """Deliver one reply update to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_reply_text(
            ReplyText(reply_id="reply_001", speech_text="好，明天下午三点", done=False),
            _Identity(),
        )

        assert len(connection.frames) == 1
        frame = connection.frames[0]
        assert frame["type"] == "voice.dialogue.reply"
        assert frame["request_id"] == "req_voice_001"
        assert frame["conversation_id"] == "conversation_test"
        assert "ok" not in frame
        assert frame["payload"] == {
            "reply_id": "reply_001",
            "speech_text": "好，明天下午三点",
            "done": False,
        }

    asyncio.run(scenario())


def test_reply_updates_go_out_in_the_order_they_were_delivered() -> None:
    """The last message a client got must be the newest wording."""

    async def scenario() -> None:
        """Deliver three updates for one reply."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        for text, done in (("好，", False), ("好，明天", False), ("好，明天三点", True)):
            await sink.deliver_reply_text(
                ReplyText(reply_id="reply_001", speech_text=text, done=done), _Identity()
            )

        assert [frame["payload"]["speech_text"] for frame in connection.frames] == [
            "好，",
            "好，明天",
            "好，明天三点",
        ]
        assert [frame["payload"]["done"] for frame in connection.frames] == [False, False, True]

    asyncio.run(scenario())


def test_deliver_question_sends_voice_dialogue_question_in_the_documented_shape() -> None:
    """A question goes out with the interface design's fields, and with no message_id."""

    async def scenario() -> None:
        """Deliver one question to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_question(
            DialogueQuestion(
                question_id="question_001",
                question_kind="ambiguous_target",
                speech_text="你说的是早会还是周会？",
                required_response="schedule_id",
                candidates=({"id": "schedule_1"}, {"id": "schedule_2"}),
            ),
            _Identity(),
        )

        assert len(connection.frames) == 1
        frame = connection.frames[0]
        assert frame["type"] == "voice.dialogue.question"
        assert frame["request_id"] == "req_voice_001"
        assert frame["conversation_id"] == "conversation_test"
        assert "message_id" not in frame
        assert "ok" not in frame
        assert frame["payload"] == {
            "question_id": "question_001",
            "question_kind": "ambiguous_target",
            "speech_text": "你说的是早会还是周会？",
            "required_response": "schedule_id",
            "candidates": [{"id": "schedule_1"}, {"id": "schedule_2"}],
        }

    asyncio.run(scenario())


def test_a_question_needing_no_particular_field_omits_it() -> None:
    """Confirming something asks for no field, so required_response stays null."""

    async def scenario() -> None:
        """Deliver a confirmation question."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_question(
            DialogueQuestion(
                question_id="question_001",
                question_kind="confirmation",
                speech_text="确定要删掉早会吗？",
            ),
            _Identity(),
        )

        payload = connection.frames[0]["payload"]
        assert payload["required_response"] is None
        assert payload["candidates"] == []

    asyncio.run(scenario())


def test_a_reply_or_question_for_a_session_that_left_is_dropped_not_raised() -> None:
    """Nobody is there to read them, and the turn must not die on the way out."""

    async def scenario() -> None:
        """Deliver both to a session that was never registered."""
        sink = WebSocketResultSink(ConnectionManager())

        await sink.deliver_reply_text(
            ReplyText(reply_id="reply_001", speech_text="好"), _Identity()
        )
        await sink.deliver_question(
            DialogueQuestion(
                question_id="question_001", question_kind="missing_field", speech_text="哪天？"
            ),
            _Identity(),
        )

    asyncio.run(scenario())


def test_a_question_kind_outside_the_protocol_is_refused_not_forwarded() -> None:
    """A kind the interface design does not define never reaches the wire."""

    async def scenario() -> None:
        """Deliver a question whose kind was invented by its producer."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        with pytest.raises(ValueError, match="question_kind"):
            await WebSocketResultSink(connections).deliver_question(
                DialogueQuestion(
                    question_id="question_001",
                    question_kind="which_one_lol",
                    speech_text="哪一个？",
                ),
                _Identity(),
            )

        assert connection.frames == []

    asyncio.run(scenario())


def test_the_accepted_kinds_are_the_four_the_interface_design_names() -> None:
    """The set is pinned to the document, not read from the constant being checked."""
    assert list(QUESTION_KINDS) == [
        "missing_field",
        "ambiguous_target",
        "recurrence_scope",
        "confirmation",
    ]


def test_every_documented_question_kind_is_accepted() -> None:
    """All four of the interface design's kinds go out unchanged."""

    async def scenario() -> None:
        """Deliver one question per documented kind."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        for kind in QUESTION_KINDS:
            await sink.deliver_question(
                DialogueQuestion(question_id="q", question_kind=kind, speech_text="？"),
                _Identity(),
            )

        assert [frame["payload"]["question_kind"] for frame in connection.frames] == list(
            QUESTION_KINDS
        )

    asyncio.run(scenario())
