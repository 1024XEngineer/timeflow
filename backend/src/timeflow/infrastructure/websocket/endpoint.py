"""FastAPI WebSocket 端点:接管单个客户端连接的收发循环。"""

from fastapi import WebSocket, WebSocketDisconnect

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.router import MessageRouter
from timeflow.infrastructure.websocket.session import handle_session_hello, invalid_device_id_error


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
        first_message = await websocket.receive_json()
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
            raw_message = await websocket.receive_json()
            reply = await router.dispatch(raw_message, device_id)
            if reply is not None:
                await websocket.send_json(reply)
    except WebSocketDisconnect:
        pass
    finally:
        connections.unregister(device_id)
