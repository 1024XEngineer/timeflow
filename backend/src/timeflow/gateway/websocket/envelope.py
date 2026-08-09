"""Outbound envelope construction.

Transport-level error codes. The architecture design (section 5.9) lists voice-semantic
codes and states the table is a minimum; these cover the transport cases it leaves open.
"""

from typing import Any

from timeflow.gateway.websocket.messages.envelope import ErrorDetail

ERROR_UNAUTHENTICATED = "UNAUTHENTICATED"
ERROR_AUDIO_INVALID = "AUDIO_INVALID"
ERROR_MALFORMED_MESSAGE = "MALFORMED_MESSAGE"
ERROR_UNKNOWN_MESSAGE_TYPE = "UNKNOWN_MESSAGE_TYPE"
ERROR_INTERNAL = "INTERNAL_ERROR"


def build_error_envelope(
    message_type: str,
    request_id: str | None,
    code: str,
    message: str,
    *,
    retryable: bool = False,
) -> dict[str, Any]:
    """Build a failed envelope of the given message type."""
    error = ErrorDetail(code=code, message=message, retryable=retryable)
    envelope: dict[str, Any] = {"type": message_type, "ok": False, "error": error.model_dump()}
    if request_id is not None:
        envelope["request_id"] = request_id
    return envelope
