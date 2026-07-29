"""SessionHello/Ready/Error 类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.session import (
    SessionError,
    SessionHello,
    SessionReady,
)


def test_session_hello_matches_doc_example() -> None:
    hello = SessionHello.model_validate(
        {"type": "session.hello", "device_id": "android_abc123", "app_version": "1.0.0"}
    )

    assert hello.device_id == "android_abc123"
    assert hello.app_version == "1.0.0"


def test_session_ready_matches_doc_example() -> None:
    ready = SessionReady.model_validate(
        {
            "type": "session.ready",
            "device_id": "android_abc123",
            "server_time": "2026-07-28T12:00:00Z",
        }
    )

    assert ready.device_id == "android_abc123"


def test_session_error_matches_doc_example() -> None:
    error = SessionError.model_validate(
        {
            "type": "session.error",
            "ok": False,
            "error": {"code": "INVALID_DEVICE_ID", "message": "设备 ID 不合法", "details": None},
        }
    )

    assert error.error.code == "INVALID_DEVICE_ID"
    assert error.error.details is None


def test_session_hello_missing_device_id_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SessionHello.model_validate({"type": "session.hello", "app_version": "1.0.0"})
