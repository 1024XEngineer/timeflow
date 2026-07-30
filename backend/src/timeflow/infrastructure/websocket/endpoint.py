"""FastAPI WebSocket 端点:接管单个客户端连接的收发循环。"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.session import SessionHello
from timeflow.infrastructure.websocket.router import MessageRouter

BinaryFrameHandler = Callable[[bytes, str], Awaitable[dict[str, Any] | None]]
ReplySentHandler = Callable[[dict[str, Any], str], Awaitable[None]]
DisconnectHandler = Callable[[str], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class _IncomingFrame:
    message: dict[str, Any] | None = None
    binary: bytes | None = None


def invalid_device_id_error() -> dict[str, Any]:
    """构造设备 ID 非法时统一返回的 `session.error`。"""
    return build_error_envelope("session.error", None, "INVALID_DEVICE_ID", "设备 ID 不合法")


def malformed_message_error() -> dict[str, Any]:
    """构造收到的帧不是合法 JSON 对象时统一返回的错误。"""
    return build_error_envelope(
        "protocol.error", None, "MALFORMED_MESSAGE", "消息不是合法的 JSON 对象"
    )


def handle_session_hello(raw_message: dict[str, Any], device_id: str) -> dict[str, Any]:
    """校验 `session.hello`,构造 `session.ready` 或 `session.error` 响应。

    按 `SessionHello` 类型校验必填字段(`device_id`、`app_version`);
    `device_id` 还必须和连接 URL 查询参数一致,否则视为非法连接。
    """
    try:
        hello = SessionHello.model_validate(raw_message)
    except ValidationError:
        return build_error_envelope(
            "session.error", None, "INVALID_MESSAGE", "session.hello 缺少必填字段"
        )

    if hello.device_id != device_id:
        return invalid_device_id_error()

    return {
        "type": "session.ready",
        "device_id": device_id,
        "server_time": datetime.now(UTC).isoformat(),
    }


async def _receive_frame(websocket: WebSocket) -> _IncomingFrame:
    """Receive one JSON Text Frame or Binary Frame without mixing their semantics."""
    raw_frame = await websocket.receive()
    if raw_frame.get("type") == "websocket.disconnect":
        raise WebSocketDisconnect(code=raw_frame.get("code", 1000))

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


async def run_websocket_session(
    websocket: WebSocket,
    router: MessageRouter,
    connections: ConnectionManager,
    binary_handler: BinaryFrameHandler | None = None,
    reply_sent_handler: ReplySentHandler | None = None,
    disconnect_handler: DisconnectHandler | None = None,
) -> None:
    """接受连接、完成 `session.hello` 握手,再把后续消息交给路由器分发。"""
    device_id = websocket.query_params.get("device_id")
    await websocket.accept()

    if not device_id:
        await websocket.send_json(invalid_device_id_error())
        await websocket.close()
        return

    try:
        first_frame = await _receive_frame(websocket)
        first_message = first_frame.message
        if first_message is None:
            await websocket.send_json(malformed_message_error())
            await websocket.close()
            return

        if first_message.get("type") != "session.hello":
            await websocket.send_json(
                build_error_envelope(
                    "session.error",
                    None,
                    "SESSION_HELLO_REQUIRED",
                    "必须先发送 session.hello",
                )
            )
            await websocket.close()
            return

        hello_response = handle_session_hello(first_message, device_id)
        await websocket.send_json(hello_response)
        if hello_response.get("type") != "session.ready":
            await websocket.close()
            return

        connections.register(device_id, websocket)

        while True:
            frame = await _receive_frame(websocket)
            if frame.binary is not None:
                if binary_handler is None:
                    binary_reply: dict[str, Any] | None = build_error_envelope(
                        "protocol.error",
                        None,
                        "UNEXPECTED_BINARY_FRAME",
                        "当前连接未启用二进制消息处理",
                    )
                else:
                    binary_reply = await binary_handler(frame.binary, device_id)
                if binary_reply is not None:
                    await websocket.send_json(binary_reply)
                    if reply_sent_handler is not None:
                        await reply_sent_handler(binary_reply, device_id)
                continue

            raw_message = frame.message
            if raw_message is None:
                async with connections.lock_for(device_id):
                    await websocket.send_json(malformed_message_error())
                continue

            text_reply = await router.dispatch(raw_message, device_id)
            if text_reply is not None:
                async with connections.lock_for(device_id):
                    await websocket.send_json(text_reply)
                if reply_sent_handler is not None:
                    await reply_sent_handler(text_reply, device_id)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            if disconnect_handler is not None:
                await disconnect_handler(device_id)
        finally:
            connections.unregister(device_id, websocket)
