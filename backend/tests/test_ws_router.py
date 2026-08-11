"""Dispatch behavior of the WebSocket message router."""

import asyncio
from typing import Any

from timeflow.gateway.websocket.ports import SessionContext
from timeflow.gateway.websocket.router import MessageRouter

SESSION = SessionContext(
    session_id="ws_session_test", account_id="acc_test", device_id="device_001"
)


def test_registered_handler_receives_the_message_and_session() -> None:
    """A registered handler is called with the raw message and the session."""
    seen: list[tuple[dict[str, Any], SessionContext]] = []

    async def handler(
        raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Record the call and reply."""
        seen.append((raw_message, session))
        return {"type": "ok"}

    async def scenario() -> None:
        """Dispatch one message to the registered handler."""
        router = MessageRouter()
        router.register("thing.do", handler)

        reply = await router.dispatch({"type": "thing.do"}, SESSION)

        assert reply == {"type": "ok"}

    asyncio.run(scenario())

    assert seen == [({"type": "thing.do"}, SESSION)]


def test_handler_returning_none_produces_no_reply() -> None:
    """A handler may choose not to reply."""

    async def handler(
        raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Reply with nothing."""
        return None

    async def scenario() -> None:
        """Dispatch to a silent handler."""
        router = MessageRouter()
        router.register("thing.do", handler)

        assert await router.dispatch({"type": "thing.do"}, SESSION) is None

    asyncio.run(scenario())


def test_unknown_message_type_is_reported() -> None:
    """An unregistered type yields UNKNOWN_MESSAGE_TYPE echoing the request id."""

    async def scenario() -> None:
        """Dispatch a type nobody handles."""
        router = MessageRouter()

        reply = await router.dispatch({"type": "thing.missing", "request_id": "req_009"}, SESSION)

        assert reply is not None
        assert reply["type"] == "thing.missing"
        assert reply["request_id"] == "req_009"
        assert reply["error"]["code"] == "UNKNOWN_MESSAGE_TYPE"

    asyncio.run(scenario())


def test_missing_message_type_is_reported() -> None:
    """A message without a string type is malformed."""

    async def scenario() -> None:
        """Dispatch a message that has no type."""
        router = MessageRouter()

        reply = await router.dispatch({"request_id": "req_010"}, SESSION)

        assert reply is not None
        assert reply["type"] == "protocol.error"
        assert reply["error"]["code"] == "MALFORMED_MESSAGE"

    asyncio.run(scenario())


def test_handler_failure_becomes_an_error_envelope() -> None:
    """A raising handler cannot tear down the session."""

    async def handler(
        raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Fail on purpose."""
        raise RuntimeError("handler exploded")

    async def scenario() -> None:
        """Dispatch to a handler that raises."""
        router = MessageRouter()
        router.register("thing.do", handler)

        reply = await router.dispatch({"type": "thing.do"}, SESSION)

        assert reply is not None
        assert reply["type"] == "thing.do"
        assert reply["error"]["code"] == "INTERNAL_ERROR"

    asyncio.run(scenario())


def test_non_string_request_id_is_omitted() -> None:
    """A request id that is not a string is dropped rather than echoed."""

    async def scenario() -> None:
        """Dispatch an unknown type carrying a numeric request id."""
        router = MessageRouter()

        reply = await router.dispatch({"type": "thing.missing", "request_id": 7}, SESSION)

        assert reply is not None
        assert "request_id" not in reply

    asyncio.run(scenario())
