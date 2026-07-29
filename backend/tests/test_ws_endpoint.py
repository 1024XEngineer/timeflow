"""端到端集成测试:连接 → 握手 → 路由 → 断连,走真实的 WebSocket。"""

from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.router import MessageRouter


def _build_app(router: MessageRouter, connections: ConnectionManager) -> FastAPI:
    app = FastAPI()

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await run_websocket_session(websocket, router, connections)

    return app


def test_missing_device_id_is_rejected() -> None:
    """不带 device_id 查询参数连接时,收到 INVALID_DEVICE_ID 后连接关闭。"""
    client = TestClient(_build_app(MessageRouter(), ConnectionManager()))

    with client.websocket_connect("/ws") as websocket:
        response = websocket.receive_json()

    assert response["type"] == "session.error"
    assert response["error"]["code"] == "INVALID_DEVICE_ID"


def test_missing_hello_first_is_rejected() -> None:
    """握手前发业务消息会被拒绝,提示必须先发送 session.hello。"""
    connections = ConnectionManager()
    client = TestClient(_build_app(MessageRouter(), connections))

    with client.websocket_connect("/ws?device_id=device_2") as websocket:
        websocket.send_json({"type": "schedule.list.query", "request_id": "req_x"})
        response = websocket.receive_json()

    assert response["type"] == "session.error"
    assert response["error"]["code"] == "SESSION_HELLO_REQUIRED"


def test_hello_then_routed_message_and_disconnect_cleanup() -> None:
    """握手成功后消息能被路由到 handler,断开连接后从 ConnectionManager 摘除。"""
    router = MessageRouter()

    async def echo_handler(raw_message: dict[str, Any], device_id: str) -> dict[str, Any]:
        return {
            "type": "echo.result",
            "request_id": raw_message["request_id"],
            "ok": True,
            "payload": {"device_id": device_id},
        }

    router.register("echo.command", echo_handler)
    connections = ConnectionManager()
    client = TestClient(_build_app(router, connections))

    with client.websocket_connect("/ws?device_id=device_1") as websocket:
        websocket.send_json(
            {"type": "session.hello", "device_id": "device_1", "app_version": "1.0.0"}
        )
        hello_response = websocket.receive_json()
        assert hello_response["type"] == "session.ready"
        assert hello_response["device_id"] == "device_1"
        assert connections.is_connected("device_1") is True

        websocket.send_json({"type": "echo.command", "request_id": "req_1"})
        echo_response = websocket.receive_json()
        assert echo_response == {
            "type": "echo.result",
            "request_id": "req_1",
            "ok": True,
            "payload": {"device_id": "device_1"},
        }

    assert connections.is_connected("device_1") is False
