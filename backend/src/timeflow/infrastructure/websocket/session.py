"""`session.hello` 握手:确认连接的设备身份。"""

from datetime import UTC, datetime
from typing import Any

from timeflow.infrastructure.websocket.envelope import build_error_envelope


def handle_session_hello(raw_message: dict[str, Any], device_id: str) -> dict[str, Any]:
    """校验 `session.hello`,构造 `session.ready` 或 `session.error` 响应。

    `device_id` 来自连接 URL 查询参数;如果 `session.hello` 消息体里也带了
    `device_id`,两者必须一致,否则视为非法连接。
    """
    hello_device_id = raw_message.get("device_id")
    if hello_device_id is not None and hello_device_id != device_id:
        return build_error_envelope("session.error", None, "INVALID_DEVICE_ID", "设备 ID 不合法")

    return {
        "type": "session.ready",
        "device_id": device_id,
        "server_time": datetime.now(UTC).isoformat(),
    }
