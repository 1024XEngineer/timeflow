"""FastAPI WebSocket 端点:接管单个客户端连接的收发循环。"""

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.session import SessionHello
from timeflow.infrastructure.websocket.router import MessageRouter


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


async def _receive_message(websocket: WebSocket) -> dict[str, Any] | None:
    """接收一帧消息;不是合法 JSON 对象时返回 `None`,由调用方决定怎么响应。"""
    try:
        raw = await websocket.receive_json()
    except (json.JSONDecodeError, UnicodeDecodeError, KeyError):
        return None
    return raw if isinstance(raw, dict) else None


async def run_websocket_session(
    websocket: WebSocket,
    router: MessageRouter,
    connections: ConnectionManager,
) -> None:
    """接受连接、完成 `session.hello` 握手,再把后续消息交给路由器分发。"""
    device_id = websocket.query_params.get("device_id")
    await websocket.accept()

    if not device_id:
        await websocket.send_json(invalid_device_id_error())
        await websocket.close()
        return

    try:
        first_message = await _receive_message(websocket)
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
            raw_message = await _receive_message(websocket)
            if raw_message is None:
                await websocket.send_json(malformed_message_error())
                continue

            reply = await router.dispatch(raw_message, device_id)
            if reply is not None:
                await websocket.send_json(reply)
    except WebSocketDisconnect:
        pass
    finally:
        connections.unregister(device_id, websocket)
