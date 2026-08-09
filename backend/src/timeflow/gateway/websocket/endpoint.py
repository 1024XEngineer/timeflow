"""The WebSocket session driver: accept, handshake, then receive and dispatch frames."""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.envelope import (
    ERROR_AUDIO_INVALID,
    ERROR_MALFORMED_MESSAGE,
    ERROR_UNAUTHENTICATED,
    build_error_envelope,
)
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.ports import SessionContext
from timeflow.gateway.websocket.router import MessageRouter

logger = logging.getLogger(__name__)

BinaryFrameHandler = Callable[[bytes, SessionContext], Awaitable[dict[str, Any] | None]]
DisconnectHandler = Callable[[SessionContext], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class _IncomingFrame:
    """One received frame: a JSON object, raw bytes, or neither when malformed."""

    message: dict[str, Any] | None = None
    binary: bytes | None = None


class UnauthenticatedConnectionLimiter:
    """Cap how many connections may sit unauthenticated at once.

    A connection that has completed the WebSocket handshake but not yet sent
    session.hello still holds memory and a file descriptor, so the count is bounded.
    """

    def __init__(self, limit: int) -> None:
        """Set the maximum number of concurrent unauthenticated connections."""
        self._limit = limit
        self._count = 0

    def try_acquire(self) -> bool:
        """Reserve a slot, reporting whether one was available."""
        if self._count >= self._limit:
            return False
        self._count += 1
        return True

    def release(self) -> None:
        """Return a slot once the connection authenticates or closes."""
        self._count = max(0, self._count - 1)


async def run_websocket_session(
    websocket: WebSocket,
    handshake: SessionHandshake,
    router: MessageRouter,
    connections: ConnectionManager,
    limiter: UnauthenticatedConnectionLimiter,
    *,
    handshake_timeout_seconds: float,
    binary_handler: BinaryFrameHandler | None = None,
    disconnect_handler: DisconnectHandler | None = None,
) -> None:
    """Serve one WebSocket connection from accept to close."""
    if not limiter.try_acquire():
        await websocket.close(code=1013)
        return

    session: SessionContext | None = None
    try:
        await websocket.accept()
        session = await _authenticate(websocket, handshake, handshake_timeout_seconds)
        if session is None:
            return
    finally:
        limiter.release()

    connections.register(session.session_id, websocket)
    try:
        await _serve_frames(websocket, session, router, connections, binary_handler)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            if disconnect_handler is not None:
                await disconnect_handler(session)
        finally:
            connections.unregister(session.session_id, websocket)


async def _authenticate(
    websocket: WebSocket, handshake: SessionHandshake, timeout_seconds: float
) -> SessionContext | None:
    """Run the handshake, closing the connection unless it succeeds.

    Waiting for the opening frame and verifying it share one deadline. Timing only the
    wait would let a verifier that never answers hold the connection, and the
    unauthenticated slot it occupies, for as long as it likes.
    """
    try:
        async with asyncio.timeout(timeout_seconds):
            frame = await _receive_frame(websocket)
            if frame.message is None:
                await websocket.send_json(
                    build_error_envelope(
                        "session.error", None, ERROR_MALFORMED_MESSAGE, "Expected a JSON object"
                    )
                )
                await websocket.close(code=1008)
                return None
            result = await handshake.perform(frame.message)
    except TimeoutError:
        # Nothing was said, or nothing came back about it, so say nothing in return.
        await websocket.close(code=1008)
        return None
    except WebSocketDisconnect:
        return None

    await websocket.send_json(result.reply)
    if result.session is None:
        await websocket.close(code=1008)
        return None
    return result.session


async def _serve_frames(
    websocket: WebSocket,
    session: SessionContext,
    router: MessageRouter,
    connections: ConnectionManager,
    binary_handler: BinaryFrameHandler | None,
) -> None:
    """Receive frames until the client disconnects, replying under the session lock."""
    while True:
        frame = await _receive_frame(websocket)

        if frame.binary is not None:
            binary_reply: dict[str, Any] | None
            if binary_handler is None:
                binary_reply = build_error_envelope(
                    "voice.command.error",
                    None,
                    ERROR_AUDIO_INVALID,
                    "This session does not accept audio frames",
                )
            else:
                binary_reply = await binary_handler(frame.binary, session)
            await _send_reply(websocket, connections, session, binary_reply)
            continue

        if frame.message is None:
            await _send_reply(
                websocket,
                connections,
                session,
                build_error_envelope(
                    "protocol.error", None, ERROR_MALFORMED_MESSAGE, "Expected a JSON object"
                ),
            )
            continue

        if frame.message.get("type") == "session.hello":
            await _send_reply(
                websocket,
                connections,
                session,
                build_error_envelope(
                    "session.error",
                    _request_id_of(frame.message),
                    ERROR_UNAUTHENTICATED,
                    "The session is already established",
                ),
            )
            continue

        await _send_reply(
            websocket, connections, session, await router.dispatch(frame.message, session)
        )


async def _send_reply(
    websocket: WebSocket,
    connections: ConnectionManager,
    session: SessionContext,
    reply: dict[str, Any] | None,
) -> None:
    """Send a reply, if there is one, holding the session write lock."""
    if reply is None:
        return
    async with connections.lock_for(session.session_id):
        await websocket.send_json(reply)


async def _receive_frame(websocket: WebSocket) -> _IncomingFrame:
    """Receive the next frame, classifying it as JSON, binary, or malformed.

    Uses the raw ASGI receive because this protocol mixes text and binary frames, which
    the typed Starlette helpers refuse to do.
    """
    raw_frame = await websocket.receive()
    if raw_frame.get("type") == "websocket.disconnect":
        raise WebSocketDisconnect(code=int(raw_frame.get("code", 1000)))

    binary = raw_frame.get("bytes")
    if isinstance(binary, bytes):
        return _IncomingFrame(binary=binary)

    text = raw_frame.get("text")
    if not isinstance(text, str):
        return _IncomingFrame()
    try:
        raw_message = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _IncomingFrame()
    if not isinstance(raw_message, dict):
        return _IncomingFrame()
    return _IncomingFrame(message=raw_message)


def _request_id_of(raw_message: dict[str, Any]) -> str | None:
    """Extract request_id when present and a string."""
    request_id = raw_message.get("request_id")
    return request_id if isinstance(request_id, str) else None
