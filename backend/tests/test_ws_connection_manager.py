"""Registry and write-serialization behavior of the connection manager."""

import asyncio
from typing import Any

from timeflow.gateway.websocket.connection_manager import ConnectionManager


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

        assert connections.is_connected("ws_session_1") is True
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

        assert connections.is_connected("ws_session_1") is False

    asyncio.run(scenario())


def test_send_audio_frames_the_payload_between_start_and_end() -> None:
    """Audio is written as start JSON, then chunks, then end JSON."""

    async def scenario() -> None:
        """Send a three-chunk audio burst."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        delivered = await connections.send_audio(
            "ws_session_1",
            {"type": "voice.tts.start"},
            b"abcdef",
            {"type": "voice.tts.end"},
            chunk_size=2,
        )

        assert delivered is True
        assert connection.frames == [
            ("json", {"type": "voice.tts.start"}),
            ("bytes", b"ab"),
            ("bytes", b"cd"),
            ("bytes", b"ef"),
            ("json", {"type": "voice.tts.end"}),
        ]

    asyncio.run(scenario())


def test_send_audio_is_not_interleaved_by_a_concurrent_send() -> None:
    """A concurrent message cannot land between the audio start and end frames."""

    async def scenario() -> None:
        """Race a plain send against an in-flight audio burst."""
        connections = ConnectionManager()
        connection = RecordingConnection()
        connections.register("ws_session_1", connection)

        audio = asyncio.create_task(
            connections.send_audio(
                "ws_session_1",
                {"type": "voice.tts.start"},
                b"abcd",
                {"type": "voice.tts.end"},
                chunk_size=1,
            )
        )
        await asyncio.sleep(0)
        other = asyncio.create_task(connections.send("ws_session_1", {"type": "ping"}))
        await asyncio.gather(audio, other)

        assert connection.frames == [
            ("json", {"type": "voice.tts.start"}),
            ("bytes", b"a"),
            ("bytes", b"b"),
            ("bytes", b"c"),
            ("bytes", b"d"),
            ("json", {"type": "voice.tts.end"}),
            ("json", {"type": "ping"}),
        ]

    asyncio.run(scenario())


def test_zero_chunk_size_is_rejected() -> None:
    """A non-positive chunk size is a programming error, not a silent no-op."""

    async def scenario() -> None:
        """Attempt an audio send with an invalid chunk size."""
        connections = ConnectionManager()
        connections.register("ws_session_1", RecordingConnection())

        try:
            await connections.send_audio(
                "ws_session_1", {"type": "s"}, b"ab", {"type": "e"}, chunk_size=0
            )
        except ValueError:
            return
        raise AssertionError("expected ValueError")

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
