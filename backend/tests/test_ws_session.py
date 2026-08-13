"""Handshake behavior for the WebSocket transport."""

import asyncio
import time
from typing import Any
from unittest import mock

from auth_test_support import build_test_token_service
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from pytest import raises
from starlette.websockets import WebSocketDisconnect

from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.security import JwtAccessTokenService

_TOKENS = build_test_token_service()
VALID_HELLO: dict[str, Any] = {
    "type": "session.hello",
    "request_id": "req_001",
    "payload": {
        "access_token": _TOKENS.issue("acc_test").access_token,
        "device_id": "device_001",
        "app_version": "0.1.0",
        "timezone": "Asia/Shanghai",
    },
}


def _build_app(
    *,
    handshake_timeout_seconds: float = 5.0,
    max_unauthenticated: int = 100,
    access_token_service: JwtAccessTokenService | None = None,
) -> FastAPI:
    """Build an app whose only route is the transport endpoint."""
    application = FastAPI()
    handshake = SessionHandshake(
        access_token_service or build_test_token_service(),
        session_id_factory=lambda: "ws_session_test",
    )
    connections = ConnectionManager()
    limiter = UnauthenticatedConnectionLimiter(max_unauthenticated)
    router = MessageRouter()

    @application.websocket("/ws")
    async def endpoint(websocket: WebSocket) -> None:
        """Serve one transport session."""
        await run_websocket_session(
            websocket,
            handshake,
            router,
            connections,
            limiter,
            handshake_timeout_seconds=handshake_timeout_seconds,
        )

    return application


def test_valid_hello_opens_a_session() -> None:
    """A valid access token yields session.ready carrying a server-issued session id."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        reply = websocket.receive_json()

    assert reply["type"] == "session.ready"
    assert reply["ok"] is True
    assert reply["request_id"] == "req_001"
    assert reply["payload"]["session_id"] == "ws_session_test"
    assert reply["payload"]["server_time"].endswith("+00:00")


def test_rejected_token_returns_unauthenticated() -> None:
    """A token the verifier rejects yields session.error with UNAUTHENTICATED."""
    client = TestClient(_build_app())
    hello = {
        **VALID_HELLO,
        "payload": {**VALID_HELLO["payload"], "access_token": "not-a-jwt"},
    }

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        reply = websocket.receive_json()
        closed = websocket.receive()

    assert reply == {
        "type": "session.error",
        "request_id": "req_001",
        "ok": False,
        "error": {
            "code": "UNAUTHENTICATED",
            "message": "Access token is not valid",
            "retryable": False,
        },
    }
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_token_service_failure_returns_a_sanitized_internal_error() -> None:
    """令牌服务意外失败时走内部错误路径，且不回显令牌或异常文本。"""
    tokens = build_test_token_service()
    internal_detail = "never-return-this-token-provider-detail"
    with mock.patch.object(tokens, "verify", side_effect=RuntimeError(internal_detail)):
        client = TestClient(_build_app(access_token_service=tokens))
        with mock.patch("timeflow.gateway.websocket.endpoint.logger.error") as log_error:
            with client.websocket_connect("/ws?device_id=device_001") as websocket:
                websocket.send_json(VALID_HELLO)
                reply = websocket.receive_json()
                closed = websocket.receive()

    assert reply["error"] == {
        "code": "INTERNAL_ERROR",
        "message": "Authentication service unavailable",
        "retryable": False,
    }
    assert reply["request_id"] == "req_001"
    assert internal_detail not in str(reply)
    log_error.assert_called_once()
    (message,) = log_error.call_args.args
    diagnostics = log_error.call_args.kwargs["extra"]
    assert message == "websocket authentication service unavailable"
    assert diagnostics["event_id"].startswith("ws_auth_event_")
    assert diagnostics["error_code"] == "INTERNAL_ERROR"
    assert diagnostics["exception_module"] == "builtins"
    assert diagnostics["exception_type"] == "RuntimeError"
    assert diagnostics["traceback_frames"]
    assert "token-abc" not in str(log_error.call_args)
    assert internal_detail not in str(log_error.call_args)
    assert all(
        set(frame) == {"filename", "lineno", "function"}
        for frame in diagnostics["traceback_frames"]
    )
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_missing_access_token_is_rejected() -> None:
    """缺少访问令牌的 hello 属于认证失败。"""
    client = TestClient(_build_app())
    hello = {"type": "session.hello", "payload": {"device_id": "device_001"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        reply = websocket.receive_json()
        closed = websocket.receive()

    assert reply["ok"] is False
    assert reply["error"]["code"] == "UNAUTHENTICATED"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_empty_access_token_is_rejected_as_unauthenticated() -> None:
    """空字符串令牌与缺失令牌使用同一认证失败语义。"""
    client = TestClient(_build_app())
    hello = {
        **VALID_HELLO,
        "payload": {**VALID_HELLO["payload"], "access_token": ""},
    }

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        reply = websocket.receive_json()
        closed = websocket.receive()

    assert reply["error"]["code"] == "UNAUTHENTICATED"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_non_string_access_token_is_malformed() -> None:
    """错误类型的令牌属于 payload 结构错误，不能触发客户端清理会话。"""
    client = TestClient(_build_app())

    for token in (False, 0, [], {}):
        hello = {
            **VALID_HELLO,
            "payload": {**VALID_HELLO["payload"], "access_token": token},
        }
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(hello)
            reply = websocket.receive_json()
            closed = websocket.receive()

        assert reply["error"]["code"] == "MALFORMED_MESSAGE"
        assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_business_message_before_hello_is_rejected() -> None:
    """The first frame must be session.hello, not a business message."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json({"type": "voice.stream.start", "payload": {}})
        reply = websocket.receive_json()
        closed = websocket.receive()

    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_url_and_payload_device_ids_must_match() -> None:
    """URL 与 hello 声明的设备标识不一致时拒绝认证。"""
    tokens = build_test_token_service()
    with mock.patch.object(tokens, "verify", wraps=tokens.verify) as verify:
        client = TestClient(_build_app(access_token_service=tokens))
        with client.websocket_connect("/ws?device_id=other-device") as websocket:
            websocket.send_json(VALID_HELLO)
            reply = websocket.receive_json()
            closed = websocket.receive()

    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}
    verify.assert_not_called()


def test_non_json_first_frame_is_rejected() -> None:
    """Text that is not a JSON object cannot open a session."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_text("not json at all")
        reply = websocket.receive_json()
        closed = websocket.receive()

    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_silent_client_is_closed_after_the_handshake_timeout() -> None:
    """A connection that never sends session.hello is closed without a reply."""
    client = TestClient(_build_app(handshake_timeout_seconds=0.05))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        message = websocket.receive()

    assert message == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_slow_token_verification_is_bounded_by_the_handshake_timeout() -> None:
    """同步令牌校验放在线程中，慢校验不会阻塞握手超时。"""
    tokens = build_test_token_service()

    def slow_verify(_token: str) -> str | None:
        time.sleep(0.2)
        return "acc_test"

    with mock.patch.object(tokens, "verify", side_effect=slow_verify):
        client = TestClient(
            _build_app(
                handshake_timeout_seconds=0.05,
                access_token_service=tokens,
            )
        )
        started_at = time.monotonic()
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(VALID_HELLO)
            message = websocket.receive()
            observed_elapsed = time.monotonic() - started_at

    assert message == {"type": "websocket.close", "code": 1008, "reason": ""}
    assert observed_elapsed < 0.15


def test_second_hello_does_not_replace_the_session() -> None:
    """Repeating session.hello is refused and leaves the established session intact."""
    tokens = build_test_token_service()
    client = TestClient(_build_app(access_token_service=tokens))

    with mock.patch.object(tokens, "verify", wraps=tokens.verify) as verify:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(VALID_HELLO)
            first = websocket.receive_json()
            websocket.send_json(VALID_HELLO)
            second = websocket.receive_json()

    assert first["payload"]["session_id"] == "ws_session_test"
    assert second["type"] == "session.error"
    assert second["error"]["code"] == "UNAUTHENTICATED"
    verify.assert_called_once_with(VALID_HELLO["payload"]["access_token"])


def test_unauthenticated_connections_are_capped() -> None:
    """Over capacity the connection is refused before it is even accepted."""
    client = TestClient(_build_app(max_unauthenticated=0))

    with raises(WebSocketDisconnect) as refusal:
        with client.websocket_connect("/ws?device_id=device_001"):
            pass

    assert refusal.value.code == 1013


def test_authenticating_frees_an_unauthenticated_slot() -> None:
    """A slot is released on success, so a single slot serves many sequential clients."""
    client = TestClient(_build_app(max_unauthenticated=1))

    async def scenario() -> None:
        """Two sequential handshakes both succeed against one slot."""
        for _ in range(2):
            with client.websocket_connect("/ws?device_id=device_001") as websocket:
                websocket.send_json(VALID_HELLO)
                assert websocket.receive_json()["type"] == "session.ready"

    asyncio.run(scenario())


def test_a_rejected_handshake_frees_its_slot() -> None:
    """Refusing a token must not consume the slot, or bad tokens become a way to fill it."""
    client = TestClient(_build_app(max_unauthenticated=1))
    rejected = {
        **VALID_HELLO,
        "payload": {**VALID_HELLO["payload"], "access_token": "not-a-jwt"},
    }

    for _ in range(5):
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(rejected)
            assert websocket.receive_json()["error"]["code"] == "UNAUTHENTICATED"

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        assert websocket.receive_json()["type"] == "session.ready"


def test_a_client_that_leaves_before_saying_hello_frees_its_slot() -> None:
    """Connecting and vanishing must not consume the slot, or it becomes a way to fill it."""
    client = TestClient(_build_app(max_unauthenticated=1))

    for _ in range(5):
        with client.websocket_connect("/ws?device_id=device_001"):
            pass

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        assert websocket.receive_json()["type"] == "session.ready"


def test_a_first_frame_of_valid_json_that_is_not_an_object_is_rejected() -> None:
    """Well-formed JSON that is not an object cannot open a session either."""
    client = TestClient(_build_app())

    for raw in ("[1, 2]", "123", '"hello"', "null"):
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_text(raw)
            reply = websocket.receive_json()
            closed = websocket.receive()

        assert reply["type"] == "session.error"
        assert reply["error"]["code"] == "MALFORMED_MESSAGE"
        assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_a_hello_whose_payload_is_not_an_object_is_rejected() -> None:
    """A payload of the wrong kind is malformed rather than treated as empty."""
    client = TestClient(_build_app())

    for payload in ("nope", [1, 2], None):
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json({"type": "session.hello", "payload": payload})
            reply = websocket.receive_json()
            closed = websocket.receive()

        assert reply["type"] == "session.error"
        assert reply["error"]["code"] == "MALFORMED_MESSAGE"
        assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}
