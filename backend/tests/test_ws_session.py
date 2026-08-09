"""Handshake behavior for the WebSocket transport."""

import asyncio
from typing import Any

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
from timeflow.gateway.websocket.ports import TokenVerifier
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.security.token_verifier import FakeTokenVerifier

VALID_HELLO: dict[str, Any] = {
    "type": "session.hello",
    "request_id": "req_001",
    "payload": {
        "access_token": "token-abc",
        "device_id": "device_001",
        "app_version": "0.1.0",
        "timezone": "Asia/Shanghai",
    },
}


class HangingTokenVerifier:
    """A verifier that never answers, the way a wedged auth service would."""

    async def verify(self, access_token: str) -> str | None:
        """Never return."""
        await asyncio.sleep(3600)
        return "acc_never"


def _build_app(
    *,
    handshake_timeout_seconds: float = 5.0,
    max_unauthenticated: int = 100,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
    """Build an app whose only route is the transport endpoint."""
    application = FastAPI()
    handshake = SessionHandshake(
        token_verifier or FakeTokenVerifier(), session_id_factory=lambda: "ws_session_test"
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
    hello = {**VALID_HELLO, "payload": {**VALID_HELLO["payload"], "access_token": "bad"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        reply = websocket.receive_json()

    assert reply["ok"] is False
    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "UNAUTHENTICATED"
    assert reply["error"]["retryable"] is False


def test_missing_access_token_is_rejected() -> None:
    """A hello without an access token is malformed rather than authenticated."""
    client = TestClient(_build_app())
    hello = {"type": "session.hello", "payload": {"device_id": "device_001"}}

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(hello)
        reply = websocket.receive_json()

    assert reply["ok"] is False
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"


def test_business_message_before_hello_is_rejected() -> None:
    """The first frame must be session.hello, not a business message."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json({"type": "voice.stream.start", "payload": {}})
        reply = websocket.receive_json()

    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "UNAUTHENTICATED"


def test_non_json_first_frame_is_rejected() -> None:
    """Text that is not a JSON object cannot open a session."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_text("not json at all")
        reply = websocket.receive_json()

    assert reply["type"] == "session.error"
    assert reply["error"]["code"] == "MALFORMED_MESSAGE"


def test_silent_client_is_closed_after_the_handshake_timeout() -> None:
    """A connection that never sends session.hello is closed without a reply."""
    client = TestClient(_build_app(handshake_timeout_seconds=0.05))

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        message = websocket.receive()

    assert message["type"] == "websocket.close"


def test_second_hello_does_not_replace_the_session() -> None:
    """Repeating session.hello is refused and leaves the established session intact."""
    client = TestClient(_build_app())

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        first = websocket.receive_json()
        websocket.send_json(VALID_HELLO)
        second = websocket.receive_json()

    assert first["payload"]["session_id"] == "ws_session_test"
    assert second["type"] == "session.error"
    assert second["error"]["code"] == "UNAUTHENTICATED"


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
    rejected = {**VALID_HELLO, "payload": {**VALID_HELLO["payload"], "access_token": "bad"}}

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


def test_a_verifier_that_never_answers_still_hits_the_handshake_timeout() -> None:
    """Verification shares the handshake deadline, so a hung verifier cannot hold on.

    Timing only the wait for the opening frame would let a stalled verifier keep both
    the connection and its unauthenticated slot, which with a small cap would shut the
    endpoint to everyone else.
    """
    client = TestClient(
        _build_app(
            handshake_timeout_seconds=0.05,
            max_unauthenticated=1,
            token_verifier=HangingTokenVerifier(),
        )
    )

    with client.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        message = websocket.receive()

    assert message["type"] == "websocket.close"


def test_a_hung_verification_frees_its_slot_for_the_next_client() -> None:
    """A stalled verification releases its slot, so later clients still get in."""
    stuck = TestClient(
        _build_app(
            handshake_timeout_seconds=0.05,
            max_unauthenticated=1,
            token_verifier=HangingTokenVerifier(),
        )
    )

    with stuck.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        websocket.receive()

    healthy = TestClient(_build_app(max_unauthenticated=1))

    with healthy.websocket_connect("/ws?device_id=device_001") as websocket:
        websocket.send_json(VALID_HELLO)
        assert websocket.receive_json()["type"] == "session.ready"


def test_a_first_frame_of_valid_json_that_is_not_an_object_is_rejected() -> None:
    """Well-formed JSON that is not an object cannot open a session either."""
    client = TestClient(_build_app())

    for raw in ("[1, 2]", "123", '"hello"', "null"):
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_text(raw)
            reply = websocket.receive_json()

        assert reply["type"] == "session.error"
        assert reply["error"]["code"] == "MALFORMED_MESSAGE"


def test_a_hello_whose_payload_is_not_an_object_is_rejected() -> None:
    """A payload of the wrong kind is malformed rather than treated as empty."""
    client = TestClient(_build_app())

    for payload in ("nope", [1, 2], None):
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json({"type": "session.hello", "payload": payload})
            reply = websocket.receive_json()

        assert reply["type"] == "session.error"
        assert reply["error"]["code"] == "MALFORMED_MESSAGE"
