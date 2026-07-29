"""通用 WS 消息信封构造函数。"""

from typing import Any

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


def build_error_envelope(
    message_type: str,
    request_id: str | None,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造所有 `*.error` 消息共用的信封,`error` 字段复用 `ErrorDetail` 的形状。"""
    error = ErrorDetail(code=code, message=message, details=details)
    envelope: dict[str, Any] = {
        "type": message_type,
        "ok": False,
        "error": error.model_dump(),
    }
    if request_id is not None:
        envelope["request_id"] = request_id
    return envelope
