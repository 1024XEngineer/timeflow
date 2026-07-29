"""按消息 `type` 分发到已注册 handler,不知道 handler 内部的具体业务逻辑。"""

from collections.abc import Awaitable, Callable
from typing import Any

from timeflow.infrastructure.websocket.envelope import build_error_envelope

MessageHandler = Callable[[dict[str, Any], str], Awaitable[dict[str, Any] | None]]


class MessageRouter:
    """把原始消息 dict 路由给对应 `type` 注册的 handler。"""

    def __init__(self) -> None:
        self._handlers: dict[str, MessageHandler] = {}

    def register(self, message_type: str, handler: MessageHandler) -> None:
        """注册某个消息 `type` 对应的处理函数。"""
        self._handlers[message_type] = handler

    async def dispatch(self, raw_message: dict[str, Any], device_id: str) -> dict[str, Any] | None:
        """把消息路由给对应 handler;类型缺失、未注册或 handler 抛异常时返回统一错误信封。"""
        message_type = raw_message.get("type")
        request_id = raw_message.get("request_id")
        if not isinstance(message_type, str):
            return build_error_envelope(
                "protocol.error",
                request_id,
                "INVALID_MESSAGE_TYPE",
                "消息缺少合法的 type 字段",
            )

        handler = self._handlers.get(message_type)
        if handler is None:
            return build_error_envelope(
                message_type,
                request_id,
                "UNKNOWN_MESSAGE_TYPE",
                f"未知的消息类型:{message_type}",
            )

        try:
            return await handler(raw_message, device_id)
        except Exception:  # noqa: BLE001 - 保护连接循环,不让单个 handler 的异常打断整个会话
            return build_error_envelope(
                message_type,
                request_id,
                "INTERNAL_ERROR",
                "服务端处理消息时发生错误",
            )
