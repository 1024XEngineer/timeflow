"""通用 WS 消息信封构造函数。"""

from typing import Any


def build_error_envelope(
    message_type: str,
    request_id: str | None,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造所有 `*.error` 消息共用的信封。"""
    envelope: dict[str, Any] = {
        "type": message_type,
        "ok": False,
        "error": {"code": code, "message": message, "details": details},
    }
    if request_id is not None:
        envelope["request_id"] = request_id
    return envelope


def build_result_envelope(
    message_type: str,
    request_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """构造所有 `*.result` 消息共用的信封。"""
    return {"type": message_type, "request_id": request_id, "ok": True, "payload": payload}
