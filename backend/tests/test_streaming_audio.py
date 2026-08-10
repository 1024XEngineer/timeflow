"""Streaming a spoken reply: framing, interleaving, cancellation and lost sessions."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.intelligence.ports import AudioReply, CommandResult

SESSION_ID = "ws_session_test"


@dataclass(frozen=True, slots=True)
class _Identity:
    """Identifiers of the stream a reply answers."""

    session_id: str = SESSION_ID
    stream_id: str = "stream_test"
    conversation_id: str = "conversation_test"
    request_id: str | None = "req_voice_001"


def _reply(audio_id: str = "audio_001") -> AudioReply:
    """Build a reply description matching what the realtime model emits."""
    return AudioReply(
        audio_id=audio_id,
        audio_format="pcm",
        sample_rate_hz=24000,
        purpose="command_result",
        speech_text="好，明天下午三点在203的会已经记下了",
    )


class RecordingConnection:
    """A stand-in socket recording frames in the order they were written."""

    def __init__(self) -> None:
        """Start with nothing sent."""
        self.frames: list[dict[str, Any] | bytes] = []

    async def send_json(self, data: Any) -> None:
        """Record one JSON frame."""
        self.frames.append(data)

    async def send_bytes(self, data: bytes) -> None:
        """Record one binary frame."""
        self.frames.append(data)

    def shape(self) -> list[str]:
        """Summarize the frames as message types, with binary frames shown as 'audio'."""
        return [
            "audio" if isinstance(frame, bytes) else str(frame["type"]) for frame in self.frames
        ]


class SuspendingConnection(RecordingConnection):
    """A socket whose sends suspend, the way a real ASGI send does.

    Needed wherever cancellation is under test: a fake that never awaits gives the
    cancellation nowhere to land, so a send in a `finally` would appear to survive
    cancellation even without being shielded.
    """

    async def send_json(self, data: Any) -> None:
        """Suspend once, then record the frame."""
        await asyncio.sleep(0)
        await super().send_json(data)

    async def send_bytes(self, data: bytes) -> None:
        """Suspend once, then record the frame."""
        await asyncio.sleep(0)
        await super().send_bytes(data)


async def _chunks(*payloads: bytes) -> AsyncIterator[bytes]:
    """Yield the given chunks with no delay."""
    for payload in payloads:
        yield payload


def test_a_reply_is_framed_by_start_and_end() -> None:
    """Audio frames sit between voice.tts.start and voice.tts.end."""

    async def scenario() -> None:
        """Speak a three-chunk reply to a connected session."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(
            _reply(), _chunks(b"aa", b"bb", b"cc"), _Identity()
        )

        assert connection.shape() == [
            "voice.tts.start",
            "audio",
            "audio",
            "audio",
            "voice.tts.end",
        ]
        start = connection.frames[0]
        assert isinstance(start, dict)
        assert start["audio_id"] == "audio_001"
        assert start["conversation_id"] == "conversation_test"
        assert start["payload"] == {
            "format": "pcm",
            "sample_rate_hz": 24000,
            "purpose": "command_result",
            "speech_text": "好，明天下午三点在203的会已经记下了",
            "schedule_id": None,
            "audio_version": None,
        }
        assert "ok" not in start
        assert connection.frames[-1] == {
            "type": "voice.tts.end",
            "conversation_id": "conversation_test",
            "audio_id": "audio_001",
        }

    asyncio.run(scenario())


def test_the_reply_text_arrives_before_any_audio() -> None:
    """speech_text rides on the start message, so the words are known before the sound.

    Without it the assistant's own words would exist only as audio, leaving nothing to
    caption, nothing to log, and nothing to show when playback fails.
    """

    async def scenario() -> None:
        """Speak a reply and read the text off the first frame."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(_reply(), _chunks(b"aa"), _Identity())

        first = connection.frames[0]
        assert isinstance(first, dict)
        assert first["type"] == "voice.tts.start"
        assert first["payload"]["speech_text"] == "好，明天下午三点在203的会已经记下了"

    asyncio.run(scenario())


def test_chunks_go_out_as_they_arrive_not_after_the_last_one() -> None:
    """A chunk reaches the wire before the producer has yielded the next one.

    This is the whole point of streaming: buffering until the producer finished would put
    every chunk on the wire at the end, and time-to-first-audio would measure nothing.
    """

    async def scenario() -> None:
        """Check what has been sent from inside the producer, between yields."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        seen_before_second_chunk: list[str] = []

        async def watched() -> AsyncIterator[bytes]:
            """Yield two chunks, recording what was on the wire in between."""
            yield b"first"
            seen_before_second_chunk.extend(connection.shape())
            yield b"second"

        await WebSocketResultSink(connections).deliver_audio(_reply(), watched(), _Identity())

        assert seen_before_second_chunk == ["voice.tts.start", "audio"]

    asyncio.run(scenario())


def test_a_command_result_can_go_out_while_a_reply_is_being_spoken() -> None:
    """JSON is not blocked by an audio burst, so a result stays deliverable mid-reply.

    Bare audio frames carry no identifier, so overlapping bursts would be ambiguous, but a
    JSON frame in the middle is not. Blocking it would make the client wait for the whole
    reply before learning what was committed.
    """

    async def scenario() -> None:
        """Send a command result from inside the audio producer."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        async def interrupting() -> AsyncIterator[bytes]:
            """Yield a chunk, push a command result, then yield another chunk."""
            yield b"first"
            await sink.deliver_result(
                CommandResult(
                    message_id="msg_a",
                    operation="create_schedule",
                    status="applied",
                    schedule={"id": "schedule_a"},
                ),
                _Identity(),
            )
            yield b"second"

        await sink.deliver_audio(_reply(), interrupting(), _Identity())

        assert connection.shape() == [
            "voice.tts.start",
            "audio",
            "voice.command.result",
            "audio",
            "voice.tts.end",
        ]

    asyncio.run(scenario())


def test_two_replies_do_not_overlap() -> None:
    """A second burst waits for the first, so no audio frame is ever ambiguous."""

    async def scenario() -> None:
        """Speak two replies at once and check the bursts stay whole."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)

        async def slow(payload: bytes) -> AsyncIterator[bytes]:
            """Yield two chunks with a suspension in between."""
            yield payload
            await asyncio.sleep(0)
            yield payload

        await asyncio.gather(
            sink.deliver_audio(_reply("audio_first"), slow(b"1"), _Identity()),
            sink.deliver_audio(_reply("audio_second"), slow(b"2"), _Identity()),
        )

        shape = connection.shape()
        assert shape.count("voice.tts.start") == 2
        assert shape.count("voice.tts.end") == 2
        # Each burst must be contiguous: start, its audio, then its own end.
        first_end = shape.index("voice.tts.end")
        assert shape[:first_end] == ["voice.tts.start", "audio", "audio"]
        assert shape[first_end + 1 :] == ["voice.tts.start", "audio", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_cancelling_a_reply_stops_it_and_still_closes_the_run() -> None:
    """A cancelled burst sends no further audio but does send voice.tts.end.

    Without the end frame a client would wait forever for a burst that stopped, so the
    close has to survive the cancellation that caused it.
    """

    async def scenario() -> None:
        """Cancel the burst after its first chunk has landed."""
        connections = ConnectionManager()
        connection = SuspendingConnection()
        connections.register(SESSION_ID, connection)
        first_chunk_sent = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            first_chunk_sent.set()
            await asyncio.Event().wait()
            yield b"never"

        speaking = asyncio.create_task(
            WebSocketResultSink(connections).deliver_audio(_reply(), endless(), _Identity())
        )
        await first_chunk_sent.wait()
        await asyncio.sleep(0)
        speaking.cancel()

        try:
            await speaking
        except asyncio.CancelledError:
            pass

        # Let the shielded end frame finish.
        await asyncio.sleep(0)

        assert connection.shape() == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_a_cancelled_reply_leaves_the_session_usable() -> None:
    """After a cancelled burst the audio lock is free, so the next reply still speaks."""

    async def scenario() -> None:
        """Cancel one burst, then speak a second one on the same session."""
        connections = ConnectionManager()
        connection = SuspendingConnection()
        connections.register(SESSION_ID, connection)
        sink = WebSocketResultSink(connections)
        started = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            started.set()
            await asyncio.Event().wait()

        speaking = asyncio.create_task(
            sink.deliver_audio(_reply("audio_a"), endless(), _Identity())
        )
        await started.wait()
        await asyncio.sleep(0)
        speaking.cancel()
        try:
            await speaking
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0)

        await asyncio.wait_for(
            sink.deliver_audio(_reply("audio_b"), _chunks(b"second"), _Identity()), timeout=1.0
        )

        assert connection.shape()[-3:] == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_a_second_cancellation_still_does_not_lose_the_end_message() -> None:
    """Cancelling again while the end message is in flight does not drop it.

    One cancel is delivered once and then cleared, so a send in a `finally` completes on
    its own. A second cancel lands on that send, which is what the end message has to be
    shielded from -- otherwise a client is left waiting for an end that never comes.
    """

    async def scenario() -> None:
        """Cancel, wait until the end message is mid-send, then cancel again."""
        connections = ConnectionManager()
        sending_end = asyncio.Event()
        release_end = asyncio.Event()

        class BlocksOnTheEndMessage(RecordingConnection):
            """A socket that parks the voice.tts.end send until released."""

            async def send_json(self, data: Any) -> None:
                """Park on the end message, send everything else straight through."""
                if data.get("type") == "voice.tts.end":
                    sending_end.set()
                    await release_end.wait()
                await super().send_json(data)

        connection = BlocksOnTheEndMessage()
        connections.register(SESSION_ID, connection)
        first_chunk_sent = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            first_chunk_sent.set()
            await asyncio.Event().wait()

        speaking = asyncio.create_task(
            WebSocketResultSink(connections).deliver_audio(_reply(), endless(), _Identity())
        )
        await first_chunk_sent.wait()
        await asyncio.sleep(0)

        speaking.cancel()
        await sending_end.wait()
        speaking.cancel()
        release_end.set()

        with contextlib.suppress(asyncio.CancelledError):
            await speaking
        await asyncio.sleep(0)

        assert connection.shape() == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_speaking_to_a_gone_session_sends_nothing() -> None:
    """A reply for a session that has closed is dropped rather than raising."""

    async def scenario() -> None:
        """Speak to a session nobody registered."""
        connections = ConnectionManager()

        await WebSocketResultSink(connections).deliver_audio(_reply(), _chunks(b"aa"), _Identity())

    asyncio.run(scenario())


def test_a_session_that_dies_mid_reply_gets_no_more_audio() -> None:
    """A socket that leaves the registry stops receiving frames part-way through."""

    async def scenario() -> None:
        """Let the connection unregister itself once the first audio frame lands."""
        connections = ConnectionManager()

        class DiesAfterFirstAudio(RecordingConnection):
            """A socket that drops out of the registry after one binary frame."""

            async def send_bytes(self, data: bytes) -> None:
                """Record the frame, then leave the registry."""
                await super().send_bytes(data)
                connections.unregister(SESSION_ID, self)

        connection = DiesAfterFirstAudio()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(
            _reply(), _chunks(b"aa", b"bb", b"cc"), _Identity()
        )

        assert connection.shape() == ["voice.tts.start", "audio"]

    asyncio.run(scenario())


def test_empty_chunks_are_skipped() -> None:
    """A producer yielding an empty chunk does not put an empty audio frame on the wire."""

    async def scenario() -> None:
        """Speak a reply whose producer yields a blank chunk in the middle."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register(SESSION_ID, connection)

        await WebSocketResultSink(connections).deliver_audio(
            _reply(), _chunks(b"aa", b"", b"bb"), _Identity()
        )

        assert connection.shape() == ["voice.tts.start", "audio", "audio", "voice.tts.end"]

    asyncio.run(scenario())
