"""`session.hello` 握手逻辑的单元测试。"""

from timeflow.infrastructure.websocket.session import handle_session_hello


def test_hello_without_device_id_field_uses_connection_device_id() -> None:
    """`session.hello` 消息体没带 device_id 时,以连接查询参数的 device_id 为准。"""
    response = handle_session_hello({"type": "session.hello", "app_version": "1.0.0"}, "device_1")

    assert response["type"] == "session.ready"
    assert response["device_id"] == "device_1"


def test_hello_with_matching_device_id_is_accepted() -> None:
    """`session.hello` 消息体的 device_id 和连接查询参数一致时握手成功。"""
    response = handle_session_hello(
        {"type": "session.hello", "device_id": "device_1", "app_version": "1.0.0"}, "device_1"
    )

    assert response["type"] == "session.ready"


def test_hello_with_mismatched_device_id_is_rejected() -> None:
    """`session.hello` 消息体的 device_id 和连接查询参数不一致时返回 INVALID_DEVICE_ID。"""
    response = handle_session_hello(
        {"type": "session.hello", "device_id": "device_2", "app_version": "1.0.0"}, "device_1"
    )

    assert response["type"] == "session.error"
    assert response["error"]["code"] == "INVALID_DEVICE_ID"
