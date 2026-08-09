"""Registry of authenticated connections, and serialized writes to each one."""

import asyncio
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

    def is_connected(self, session_id: str) -> bool:
        """Report whether a session currently has a connection."""
        return session_id in self._connections

    def lock_for(self, session_id: str) -> asyncio.Lock:
        """Return the write lock for a session, creating it on first use."""
        return self._locks.setdefault(session_id, asyncio.Lock())

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
