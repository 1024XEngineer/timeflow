"""Registry and write-serialization behavior of the connection manager."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Any

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.messages.tts import (
    PURPOSE_COMMAND_RESULT,
    VoiceTtsEnd,
    VoiceTtsStart,
    VoiceTtsStartPayload,
)


class RecordingConnection:
    """A stand-in socket that records the frames written to it."""

    def __init__(self) -> None:
        """Start with nothing sent."""
        self.frames: list[tuple[str, Any]] = []

    async def send_json(self, data: Any) -> None:
        """Record one JSON frame."""
        self.frames.append(("json", data))

    async def send_bytes(self, data: bytes) -> None:
        """Record one binary frame."""
        self.frames.append(("bytes", data))

    def shape(self) -> list[str]:
        """Summarize the frames as message types, with binary frames shown as 'audio'."""
        return ["audio" if kind == "bytes" else str(data["type"]) for kind, data in self.frames]


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


def _tts_start(audio_id: str = "audio_001") -> dict[str, Any]:
    """Build the message that opens a run of audio frames."""
    return VoiceTtsStart(
        conversation_id="conversation_test",
        audio_id=audio_id,
        payload=VoiceTtsStartPayload(
            format="pcm",
            sample_rate_hz=24000,
            purpose=PURPOSE_COMMAND_RESULT,
            speech_text="好，已经记下了",
        ),
    ).model_dump()


def _tts_end(audio_id: str = "audio_001") -> dict[str, Any]:
    """Build the message that closes a run of audio frames."""
    return VoiceTtsEnd(conversation_id="conversation_test", audio_id=audio_id).model_dump()


async def _chunks(*payloads: bytes) -> AsyncIterator[bytes]:
    """Yield the given chunks with no delay."""
    for payload in payloads:
        yield payload


def test_send_reaches_a_registered_session() -> None:
    """A registered session receives the message and the send reports success."""

    async def scenario() -> None:
        """Register a connection and send to it."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        delivered = await connections.send("ws_session_1", {"type": "ping"})

        assert delivered is True
        assert connection.frames == [("json", {"type": "ping"})]

    asyncio.run(scenario())


def test_send_to_an_unknown_session_reports_failure() -> None:
    """Sending to a session that is not connected fails rather than raising."""

    async def scenario() -> None:
        """Send to a session nobody registered."""
        connections = ConnectionManager()

        assert await connections.send("ws_session_missing", {"type": "ping"}) is False

    asyncio.run(scenario())


def test_send_to_account_reaches_only_owned_sessions() -> None:
    async def scenario() -> None:
        connections = ConnectionManager()
        account_a = RecordingConnection()
        account_b = RecordingConnection()
        connections.register("ws_a", account_a, "account-a")
        connections.register("ws_b", account_b, "account-b")

        delivered = await connections.send_to_account(
            "account-a", {"type": "schedule.category.updated"}
        )

        assert delivered == 1
        assert account_a.shape() == ["schedule.category.updated"]
        assert account_b.frames == []

    asyncio.run(scenario())


def test_send_to_account_reports_zero_when_account_has_no_sessions() -> None:
    async def scenario() -> None:
        assert await ConnectionManager().send_to_account("account-missing", {"type": "ping"}) == 0

    asyncio.run(scenario())


def test_publish_to_account_nowait_bridges_worker_event_to_event_loop() -> None:
    async def scenario() -> None:
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_a", connection, "account-a")

        connections.publish_to_account_nowait("account-a", {"type": "schedule.category.updated"})
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert connection.shape() == ["schedule.category.updated"]

    asyncio.run(scenario())


def test_unregister_keeps_a_replacement_connection() -> None:
    """A late unregister from the old connection must not evict the new one.

    This is the reconnect race: the replacement registers first, then the old
    connection's cleanup runs. Removing by key alone would blackhole the live session.
    """

    async def scenario() -> None:
        """Replace a connection, then let the old one unregister."""
        connections = ConnectionManager()
        old = RecordingConnection()
        new = RecordingConnection()
        connections.register("ws_session_1", old)
        connections.register("ws_session_1", new)

        connections.unregister("ws_session_1", old)

        assert await connections.send("ws_session_1", {"type": "ping"}) is True
        assert new.frames == [("json", {"type": "ping"})]
        assert old.frames == []

    asyncio.run(scenario())


def test_unregister_releases_the_owning_connection() -> None:
    """The connection that still owns a session does remove it."""

    async def scenario() -> None:
        """Register then unregister the same connection."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        connections.unregister("ws_session_1", connection)

        # Asserted through observable behaviour rather than the registry's internals.
        assert await connections.send("ws_session_1", {"type": "ping"}) is False
        assert connection.frames == []

    asyncio.run(scenario())


def test_stream_audio_frames_the_chunks_between_start_and_end() -> None:
    """Audio is written as start JSON, then each chunk, then end JSON."""

    async def scenario() -> None:
        """Stream a three-chunk burst."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        delivered = await connections.stream_audio(
            "ws_session_1", _tts_start(), _chunks(b"ab", b"cd", b"ef"), _tts_end()
        )

        assert delivered is True
        assert connection.shape() == [
            "voice.tts.start",
            "audio",
            "audio",
            "audio",
            "voice.tts.end",
        ]
        assert connection.frames[1] == ("bytes", b"ab")

    asyncio.run(scenario())


def test_chunks_go_out_as_they_arrive_not_after_the_last_one() -> None:
    """A chunk reaches the wire before the producer has yielded the next one.

    This is what streaming buys: buffering until the producer finished would put every
    chunk on the wire at the end, and time-to-first-audio would measure nothing.
    """

    async def scenario() -> None:
        """Check what has been sent from inside the producer, between yields."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)
        seen_before_second_chunk: list[str] = []

        async def watched() -> AsyncIterator[bytes]:
            """Yield two chunks, recording what was on the wire in between."""
            yield b"first"
            seen_before_second_chunk.extend(connection.shape())
            yield b"second"

        await connections.stream_audio("ws_session_1", _tts_start(), watched(), _tts_end())

        assert seen_before_second_chunk == ["voice.tts.start", "audio"]

    asyncio.run(scenario())


def test_a_plain_send_may_land_between_the_audio_frames() -> None:
    """JSON is not blocked by an audio burst, so a result stays deliverable mid-reply.

    Bare audio frames carry no identifier, so two overlapping bursts would make every
    frame ambiguous -- that is what the audio lock prevents. A JSON frame in the middle is
    not ambiguous, and blocking it would make a client wait for the whole reply before
    learning what was committed.
    """

    async def scenario() -> None:
        """Push a plain message from inside the audio producer."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        async def interrupting() -> AsyncIterator[bytes]:
            """Yield a chunk, send a plain message, then yield another chunk."""
            yield b"a"
            await connections.send("ws_session_1", {"type": "voice.command.result"})
            yield b"b"

        await connections.stream_audio("ws_session_1", _tts_start(), interrupting(), _tts_end())

        assert connection.shape() == [
            "voice.tts.start",
            "audio",
            "voice.command.result",
            "audio",
            "voice.tts.end",
        ]

    asyncio.run(scenario())


def test_two_bursts_do_not_overlap() -> None:
    """A second burst waits for the first, so no audio frame is ever ambiguous."""

    async def scenario() -> None:
        """Stream two bursts at once and check each stays whole."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        async def slow(payload: bytes) -> AsyncIterator[bytes]:
            """Yield two chunks with a suspension in between."""
            yield payload
            await asyncio.sleep(0)
            yield payload

        await asyncio.gather(
            connections.stream_audio(
                "ws_session_1", _tts_start("audio_first"), slow(b"1"), _tts_end("audio_first")
            ),
            connections.stream_audio(
                "ws_session_1", _tts_start("audio_second"), slow(b"2"), _tts_end("audio_second")
            ),
        )

        shape = connection.shape()
        first_end = shape.index("voice.tts.end")
        assert shape[:first_end] == ["voice.tts.start", "audio", "audio"]
        assert shape[first_end + 1 :] == ["voice.tts.start", "audio", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_cancelling_a_burst_stops_it_and_still_closes_the_run() -> None:
    """A cancelled burst sends no further audio but does send its end message.

    Without the end frame a client would wait forever for a burst that stopped, so the
    close has to survive the cancellation that caused it.
    """

    async def scenario() -> None:
        """Cancel the burst after its first chunk has landed."""
        connections = ConnectionManager()
        connection = SuspendingConnection()
        connections.register("ws_session_1", connection)
        first_chunk_sent = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            first_chunk_sent.set()
            await asyncio.Event().wait()

        burst = asyncio.create_task(
            connections.stream_audio("ws_session_1", _tts_start(), endless(), _tts_end())
        )
        await first_chunk_sent.wait()
        await asyncio.sleep(0)
        burst.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await burst
        await asyncio.sleep(0)

        assert connection.shape() == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_a_second_cancellation_still_does_not_lose_the_end_message() -> None:
    """Cancelling again while the end message is in flight does not drop it.

    One cancel is delivered once and then cleared, so a send in a `finally` completes on
    its own. A second cancel lands on that send, which is what the end message has to be
    shielded from.
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
        connections.register("ws_session_1", connection)
        first_chunk_sent = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            first_chunk_sent.set()
            await asyncio.Event().wait()

        burst = asyncio.create_task(
            connections.stream_audio("ws_session_1", _tts_start(), endless(), _tts_end())
        )
        await first_chunk_sent.wait()
        await asyncio.sleep(0)

        burst.cancel()
        await sending_end.wait()
        burst.cancel()
        release_end.set()

        with contextlib.suppress(asyncio.CancelledError):
            await burst
        await asyncio.sleep(0)

        assert connection.shape() == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_a_cancelled_burst_leaves_the_session_usable() -> None:
    """After a cancelled burst the audio lock is free, so the next burst still goes out."""

    async def scenario() -> None:
        """Cancel one burst, then stream a second one on the same session."""
        connections = ConnectionManager()
        connection = SuspendingConnection()
        connections.register("ws_session_1", connection)
        started = asyncio.Event()

        async def endless() -> AsyncIterator[bytes]:
            """Yield one chunk, then block forever."""
            yield b"first"
            started.set()
            await asyncio.Event().wait()

        burst = asyncio.create_task(
            connections.stream_audio(
                "ws_session_1", _tts_start("audio_a"), endless(), _tts_end("audio_a")
            )
        )
        await started.wait()
        await asyncio.sleep(0)
        burst.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await burst
        await asyncio.sleep(0)

        await asyncio.wait_for(
            connections.stream_audio(
                "ws_session_1", _tts_start("audio_b"), _chunks(b"second"), _tts_end("audio_b")
            ),
            timeout=1.0,
        )

        assert connection.shape()[-3:] == ["voice.tts.start", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_streaming_to_a_gone_session_reports_failure() -> None:
    """A burst for a session that has closed is dropped rather than raising."""

    async def scenario() -> None:
        """Stream to a session nobody registered."""
        connections = ConnectionManager()

        delivered = await connections.stream_audio(
            "ws_session_1", _tts_start(), _chunks(b"ab"), _tts_end()
        )

        assert delivered is False

    asyncio.run(scenario())


def test_a_session_that_dies_mid_burst_gets_no_more_audio() -> None:
    """A socket that leaves the registry stops receiving frames part-way through."""

    async def scenario() -> None:
        """Let the connection unregister itself once the first audio frame lands."""
        connections = ConnectionManager()

        class DiesAfterFirstAudio(RecordingConnection):
            """A socket that drops out of the registry after one binary frame."""

            async def send_bytes(self, data: bytes) -> None:
                """Record the frame, then leave the registry."""
                await super().send_bytes(data)
                connections.unregister("ws_session_1", self)

        connection = DiesAfterFirstAudio()
        connections.register("ws_session_1", connection)

        delivered = await connections.stream_audio(
            "ws_session_1", _tts_start(), _chunks(b"a", b"b", b"c"), _tts_end()
        )

        assert delivered is False
        assert connection.shape() == ["voice.tts.start", "audio"]

    asyncio.run(scenario())


def test_empty_chunks_are_skipped() -> None:
    """A producer yielding an empty chunk does not put an empty audio frame on the wire."""

    async def scenario() -> None:
        """Stream a burst whose producer yields a blank chunk in the middle."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        await connections.stream_audio(
            "ws_session_1", _tts_start(), _chunks(b"a", b"", b"b"), _tts_end()
        )

        assert connection.shape() == ["voice.tts.start", "audio", "audio", "voice.tts.end"]

    asyncio.run(scenario())


def test_locks_are_dropped_when_a_session_ends() -> None:
    """Session locks do not accumulate for sessions that have gone away."""

    async def scenario() -> None:
        """Take a lock for a session, then unregister it."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)
        first_lock = connections.lock_for("ws_session_1")

        connections.unregister("ws_session_1", connection)

        assert connections.lock_for("ws_session_1") is not first_lock

    asyncio.run(scenario())
