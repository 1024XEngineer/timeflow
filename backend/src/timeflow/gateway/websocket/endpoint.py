"""The WebSocket session driver: accept, handshake, then receive and dispatch frames."""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from opentelemetry import context as otel_context
from opentelemetry.trace import SpanKind, Status, StatusCode, get_tracer, set_span_in_context

from timeflow.gateway.auth_diagnostics import log_sanitized_exception
from timeflow.gateway.observability.sessions import (
    NOOP_SESSION_TRACKER,
    VoiceSessionTracker,
)
from timeflow.gateway.observability.websocket import (
    dec_ws_connections,
    inc_ws_connections,
    record_ws_disconnect,
    record_ws_handshake,
)
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.envelope import (
    ERROR_AUDIO_INVALID,
    ERROR_INTERNAL,
    ERROR_MALFORMED_MESSAGE,
    ERROR_UNAUTHENTICATED,
    build_error_envelope,
)
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.ports import SessionContext
from timeflow.gateway.websocket.router import MessageRouter

logger = logging.getLogger(__name__)

_AUTH_INTERNAL_MESSAGE = "Authentication service unavailable"

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
    agent_mode: str = "realtime",
    sessions: VoiceSessionTracker | None = None,
) -> None:
    """Serve one WebSocket connection from accept to close."""
    occupancy = sessions if sessions is not None else NOOP_SESSION_TRACKER
    started = time.perf_counter()
    if not limiter.try_acquire():
        record_ws_handshake("rejected_limiter", time.perf_counter() - started)
        record_ws_disconnect("limiter")
        await websocket.close(code=1013)
        return

    session: SessionContext | None = None
    accepted = False
    disconnect_reason = "error"
    span = get_tracer("timeflow.gateway").start_span(
        "ws.session",
        kind=SpanKind.SERVER,
        attributes={"http.route": "/ws"},
    )
    token = otel_context.attach(set_span_in_context(span))
    try:
        await websocket.accept()
        accepted = True
        inc_ws_connections()
        session, handshake_result = await _authenticate(
            websocket, handshake, handshake_timeout_seconds
        )
        handshake_duration = time.perf_counter() - started
        if session is None:
            record_ws_handshake(handshake_result, handshake_duration)
            record_ws_disconnect(handshake_result)
            span.set_attribute("timeflow.ws.handshake", handshake_result)
            span.set_attribute("timeflow.ws.disconnect_reason", handshake_result)
            if handshake_result != "disconnect":
                span.set_status(Status(StatusCode.ERROR))
            return
        record_ws_handshake("success", handshake_duration)
        span.set_attribute("timeflow.ws.handshake", "success")
        span.set_attribute("timeflow.voice_mode", session.voice_mode)
    except Exception:
        if accepted and session is None:
            record_ws_handshake("internal", time.perf_counter() - started)
            record_ws_disconnect("internal")
            span.set_attribute("timeflow.ws.handshake", "internal")
            span.set_status(Status(StatusCode.ERROR))
        raise
    finally:
        limiter.release()
        if session is None and accepted:
            dec_ws_connections()
        if session is None:
            span.end()
            otel_context.detach(token)

    assert session is not None
    occupancy.attach(session.session_id, voice_mode=session.voice_mode, agent_mode=agent_mode)
    try:
        connections.register(session.session_id, websocket, session.account_id)
        await _serve_frames(websocket, session, router, connections, binary_handler)
        disconnect_reason = "client"
    except WebSocketDisconnect:
        disconnect_reason = "client"
    except Exception:
        disconnect_reason = "error"
        span.set_status(Status(StatusCode.ERROR))
        raise
    finally:
        try:
            if disconnect_handler is not None:
                await disconnect_handler(session)
        finally:
            connections.unregister(session.session_id, websocket)
            occupancy.finish(session.session_id, server_error=disconnect_reason == "error")
            record_ws_disconnect(disconnect_reason)
            span.set_attribute("timeflow.ws.disconnect_reason", disconnect_reason)
            span.end()
            otel_context.detach(token)
            dec_ws_connections()


async def _authenticate(
    websocket: WebSocket, handshake: SessionHandshake, timeout_seconds: float
) -> tuple[SessionContext | None, str]:
    """在超时内接收首帧，并在握手失败时关闭连接。"""
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
                return None, "malformed"
            # JWT 校验是同步端口，放入线程避免阻塞事件循环并让超时可取消等待。
            try:
                result = await asyncio.to_thread(
                    handshake.perform,
                    frame.message,
                    url_device_id=websocket.query_params.get("device_id"),
                )
            except Exception as error:
                # 验证器故障不能伪装成普通的无效令牌；日志只保留脱敏诊断字段。
                log_sanitized_exception(
                    logger,
                    error,
                    event_prefix="ws_auth_event",
                    error_code=ERROR_INTERNAL,
                    message="websocket authentication service unavailable",
                )
                await websocket.send_json(
                    build_error_envelope(
                        "session.error",
                        _request_id_of(frame.message),
                        ERROR_INTERNAL,
                        _AUTH_INTERNAL_MESSAGE,
                    )
                )
                await websocket.close(code=1008)
                return None, "internal"
    except TimeoutError:
        # 客户端未按时发送首帧时直接关闭，不构造无法关联请求的响应。
        await websocket.close(code=1008)
        return None, "timeout"
    except WebSocketDisconnect:
        return None, "disconnect"

    await websocket.send_json(result.reply)
    if result.session is None:
        await websocket.close(code=1008)
        return None, "auth_failed"
    return result.session, "success"


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
