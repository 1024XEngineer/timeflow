"""How a turn result reaches the wire, when things go wrong or happen at once."""

import asyncio
from dataclasses import dataclass
from typing import Any

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.intelligence.ports import AgentResult, Transcript

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
        """Record nothing; results never go out as binary."""


def _result(tag: str, *, session_id: str = SESSION_ID) -> AgentResult:
    """Build a turn result tagged so its two messages can be told apart."""
    return AgentResult(
        stream=_Identity(session_id=session_id),
        message_id=tag,
        transcript=Transcript(text=tag, language="zh", duration_ms=10),
        operation="create_schedule",
        status="applied",
        schedule={"id": tag},
    )


def _turn_tag(frame: dict[str, Any]) -> str:
    """Return the tag of whichever turn a frame belongs to."""
    if frame["type"] == "voice.asr.completed":
        return str(frame["payload"]["transcript"])
    return str(frame["message_id"])


def test_a_turn_sends_the_transcript_before_the_command_result() -> None:
    """The two messages of a turn go out in that order."""

    async def scenario() -> None:
        """Deliver one turn to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver(_result("msg_a"))

        assert [frame["type"] for frame in connection.frames] == [
            "voice.asr.completed",
            "voice.command.result",
        ]

    asyncio.run(scenario())


def test_delivering_to_a_gone_session_sends_nothing() -> None:
    """A result for a session that has closed is dropped rather than raising."""

    async def scenario() -> None:
        """Deliver a turn for a session nobody registered."""
        connections = ConnectionManager()

        await WebSocketResultSink(connections).deliver(_result("msg_a"))

    asyncio.run(scenario())


def test_a_session_that_dies_mid_turn_gets_no_second_message() -> None:
    """A connection that leaves after the transcript is never written to again.

    Pins the observable half-delivered turn: whatever delivery does internally, a socket
    that has left the registry receives nothing further.
    """

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

        await WebSocketResultSink(connections).deliver(_result("msg_a"))

        assert [frame["type"] for frame in connection.frames] == ["voice.asr.completed"]

    asyncio.run(scenario())


def test_a_result_follows_a_reconnect_that_lands_before_it_is_written() -> None:
    """A result addressed to a replaced connection is not written to the stale socket.

    The reconnect is made to land while delivery is already waiting for the session's
    write lock, which is the only moment the stale socket could still be written to.
    """

    async def scenario() -> None:
        """Hold the write lock, start delivery, reconnect, then let delivery proceed."""
        connections = ConnectionManager()
        stale = RecordingConnection()
        live = RecordingConnection()
        connections.register(SESSION_ID, stale)

        async with connections.lock_for(SESSION_ID):
            delivery = asyncio.create_task(
                WebSocketResultSink(connections).deliver(_result("msg_a"))
            )
            await asyncio.sleep(0)
            connections.register(SESSION_ID, live)

        await delivery

        assert stale.frames == []

    asyncio.run(scenario())


def test_two_turns_delivered_at_once_do_not_interleave() -> None:
    """Each turn's two messages stay adjacent, so a client never pairs them wrongly."""

    async def scenario() -> None:
        """Deliver two turns concurrently to one session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        await asyncio.gather(sink.deliver(_result("msg_a")), sink.deliver(_result("msg_b")))

        tags = [_turn_tag(frame) for frame in connection.frames]

        assert len(tags) == 4
        assert tags[0] == tags[1]
        assert tags[2] == tags[3]
        assert tags[0] != tags[2]

    asyncio.run(scenario())


def test_turns_for_different_sessions_stay_apart() -> None:
    """Two sessions each receive only their own turn."""

    async def scenario() -> None:
        """Deliver one turn per session, concurrently."""
        connections = ConnectionManager()
        first = RecordingConnection()
        second = RecordingConnection()
        connections.register("ws_session_first", first)
        connections.register("ws_session_second", second)
        sink = WebSocketResultSink(connections)

        await asyncio.gather(
            sink.deliver(_result("msg_first", session_id="ws_session_first")),
            sink.deliver(_result("msg_second", session_id="ws_session_second")),
        )

        assert {_turn_tag(frame) for frame in first.frames} == {"msg_first"}
        assert {_turn_tag(frame) for frame in second.frames} == {"msg_second"}

    asyncio.run(scenario())
