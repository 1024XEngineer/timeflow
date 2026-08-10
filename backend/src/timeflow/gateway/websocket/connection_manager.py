"""Registry of authenticated connections, and serialized writes to each one.

Two separate guards, because they answer two different questions.

The write lock keeps individual frames from racing: a WebSocket does no internal write
locking, so two concurrent sends could corrupt the stream. It is held for one frame at a
time and never across a whole burst.

The audio lock keeps two audio bursts from overlapping. Audio arrives as bare binary
frames carrying no identifier (architecture design section 5.8), so the only thing that
says which burst a frame belongs to is that it sits between that burst's start and end
messages. Two overlapping bursts would make every frame ambiguous. A JSON frame passing
through the middle creates no such ambiguity, which is why it is not blocked -- a command
result stays deliverable while a reply is still being spoken.
"""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Any, Protocol


class Sendable(Protocol):
    """The subset of a WebSocket this registry writes to."""

    async def send_json(self, data: Any) -> None:
        """Send one JSON text frame."""
        ...

    async def send_bytes(self, data: bytes) -> None:
        """Send one binary frame."""
        ...


class ConnectionManager:
    """Track live sessions and serialize concurrent writes per session.

    A WebSocket has no internal write locking, and both the receive loop and background
    tasks may push to the same socket, so every writer must hold the session lock.
    """

    def __init__(self) -> None:
        """Create an empty registry."""
        self._connections: dict[str, Sendable] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._audio_locks: dict[str, asyncio.Lock] = {}
        self._pending_ends: set[asyncio.Task[bool]] = set()

    def register(self, session_id: str, connection: Sendable) -> None:
        """Record the connection serving a session."""
        self._connections[session_id] = connection

    def unregister(self, session_id: str, connection: Sendable) -> None:
        """Drop the session, but only if this exact connection still owns it.

        Identity matters: a reconnect may already have replaced the entry, and removing
        it by key alone would silently blackhole pushes to the live connection.
        """
        if self._connections.get(session_id) is connection:
            self._connections.pop(session_id, None)
            self._locks.pop(session_id, None)
            self._audio_locks.pop(session_id, None)

    def is_connected(self, session_id: str) -> bool:
        """Report whether a session currently has a connection."""
        return session_id in self._connections

    def lock_for(self, session_id: str) -> asyncio.Lock:
        """Return the write lock for a session, creating it on first use."""
        return self._locks.setdefault(session_id, asyncio.Lock())

    def audio_lock_for(self, session_id: str) -> asyncio.Lock:
        """Return the lock admitting one audio burst at a time, creating it on first use."""
        return self._audio_locks.setdefault(session_id, asyncio.Lock())

    async def send(self, session_id: str, message: dict[str, Any]) -> bool:
        """Send one message, reporting whether the session was still connected."""
        connection = self._connections.get(session_id)
        if connection is None:
            return False
        async with self.lock_for(session_id):
            if self._connections.get(session_id) is not connection:
                return False
            await connection.send_json(message)
        return True

    async def send_audio(
        self,
        session_id: str,
        start_message: dict[str, Any],
        audio_data: bytes,
        end_message: dict[str, Any],
        *,
        chunk_size: int = 64 * 1024,
    ) -> bool:
        """Send a start frame, the audio chunks, and an end frame as one atomic burst.

        Holding the lock across the whole sequence is what lets a client assume every
        binary frame between start and end belongs to this stream.
        """
        if chunk_size <= 0:
            raise ValueError("chunk_size must be greater than zero")
        connection = self._connections.get(session_id)
        if connection is None:
            return False
        async with self.lock_for(session_id):
            if self._connections.get(session_id) is not connection:
                return False
            await connection.send_json(start_message)
            for offset in range(0, len(audio_data), chunk_size):
                await connection.send_bytes(audio_data[offset : offset + chunk_size])
            await connection.send_json(end_message)
        return True

    async def stream_audio(
        self,
        session_id: str,
        start_message: dict[str, Any],
        chunks: AsyncIterator[bytes],
        end_message: dict[str, Any],
    ) -> bool:
        """Forward each audio chunk as it arrives, framed by a start and an end message.

        Unlike send_audio this never waits for the whole reply: a producer that yields its
        first chunk early gets that chunk on the wire immediately, which is the only way
        time-to-first-audio can reflect how fast the producer actually is.

        Holds the audio lock for the burst so no second burst overlaps, but takes the write
        lock one frame at a time, so other messages can still go out in between.

        Cancelling the caller stops the burst at once and still sends the end message, so a
        client is never left waiting for the end of a burst that will never continue.
        """
        connection = self._connections.get(session_id)
        if connection is None:
            return False
        async with self.audio_lock_for(session_id):
            if not await self._send_frame(session_id, connection, start_message):
                return False
            delivered = True
            try:
                async for chunk in chunks:
                    if not chunk:
                        continue
                    if not await self._send_frame(session_id, connection, chunk):
                        delivered = False
                        break
            finally:
                await self._send_end_frame(session_id, connection, end_message)
        return delivered

    async def _send_frame(
        self, session_id: str, connection: Sendable, frame: dict[str, Any] | bytes
    ) -> bool:
        """Send one frame under the write lock, reporting whether it reached this connection."""
        async with self.lock_for(session_id):
            if self._connections.get(session_id) is not connection:
                return False
            if isinstance(frame, bytes):
                await connection.send_bytes(frame)
            else:
                await connection.send_json(frame)
        return True

    async def _send_end_frame(
        self, session_id: str, connection: Sendable, end_message: dict[str, Any]
    ) -> None:
        """Send the end message even when the burst is being cancelled.

        Awaiting normally here would re-raise the cancellation before the frame went out, so
        the send runs as its own shielded task. The reference is held until it finishes
        because the event loop keeps only a weak one.
        """
        ender = asyncio.create_task(self._send_frame(session_id, connection, end_message))
        self._pending_ends.add(ender)
        ender.add_done_callback(self._pending_ends.discard)
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.shield(ender)
