"""Dispatch of inbound control messages to their handlers."""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from timeflow.gateway.websocket.envelope import (
    ERROR_INTERNAL,
    ERROR_MALFORMED_MESSAGE,
    ERROR_UNKNOWN_MESSAGE_TYPE,
    build_error_envelope,
)
from timeflow.gateway.websocket.ports import SessionContext

logger = logging.getLogger(__name__)

MessageHandler = Callable[[dict[str, Any], SessionContext], Awaitable[dict[str, Any] | None]]


class MessageRouter:
    """Route messages by their `type` field."""

    def __init__(self) -> None:
        """Create a router with no handlers."""
        self._handlers: dict[str, MessageHandler] = {}

    def register(self, message_type: str, handler: MessageHandler) -> None:
        """Bind a handler to a message type."""
        self._handlers[message_type] = handler

    async def dispatch(
        self, raw_message: dict[str, Any], session: SessionContext
    ) -> dict[str, Any] | None:
        """Run the handler for a message and return its reply, if any.

        Handler failures become error envelopes rather than propagating, so one bad
        message cannot tear down the session.
        """
        message_type = raw_message.get("type")
        request_id = raw_message.get("request_id")
        if not isinstance(request_id, str):
            request_id = None

        if not isinstance(message_type, str):
            return build_error_envelope(
                "protocol.error", request_id, ERROR_MALFORMED_MESSAGE, "Message type is missing"
            )

        handler = self._handlers.get(message_type)
        if handler is None:
            return build_error_envelope(
                message_type,
                request_id,
                ERROR_UNKNOWN_MESSAGE_TYPE,
                f"Unsupported message type: {message_type}",
            )

        try:
            return await handler(raw_message, session)
        except Exception:
            logger.exception(
                "websocket handler failed",
                extra={"message_type": message_type, "session_id": session.session_id},
            )
            return build_error_envelope(
                message_type, request_id, ERROR_INTERNAL, "Internal error handling the message"
            )
