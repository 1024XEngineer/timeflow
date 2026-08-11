"""The message.ack confirmation, recorded and never answered."""

import logging
from typing import Any

from pydantic import ValidationError

from timeflow.gateway.websocket.envelope import ERROR_MALFORMED_MESSAGE, build_error_envelope
from timeflow.gateway.websocket.messages.agent import MessageAck
from timeflow.gateway.websocket.ports import SessionContext

logger = logging.getLogger(__name__)


async def handle_message_ack(
    raw_message: dict[str, Any], session: SessionContext
) -> dict[str, Any] | None:
    """Record an applied command result and reply with nothing."""
    try:
        ack = MessageAck.model_validate(raw_message)
    except ValidationError:
        return build_error_envelope(
            "message.ack", None, ERROR_MALFORMED_MESSAGE, "message.ack payload is invalid"
        )

    logger.info(
        "client acknowledged a command result",
        extra={
            "session_id": session.session_id,
            "message_id": ack.message_id,
            "status": ack.status,
        },
    )
    return None
