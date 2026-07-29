"""MessageRouter 的单元测试。"""

import asyncio
from typing import Any

from timeflow.infrastructure.websocket.router import MessageRouter


def test_dispatch_routes_to_registered_handler() -> None:
    """已注册 type 的消息被路由到对应 handler,收到 handler 的返回值。"""

    async def scenario() -> None:
        router = MessageRouter()

        async def echo_handler(raw_message: dict[str, Any], device_id: str) -> dict[str, Any]:
            return {"type": "echo.result", "device_id": device_id, "echo": raw_message}

        router.register("echo.command", echo_handler)

        result = await router.dispatch({"type": "echo.command", "value": 1}, "device_1")

        assert result == {
            "type": "echo.result",
            "device_id": "device_1",
            "echo": {"type": "echo.command", "value": 1},
        }

    asyncio.run(scenario())


def test_dispatch_unknown_type_returns_error() -> None:
    """未注册的消息 type 返回 UNKNOWN_MESSAGE_TYPE 错误,不抛异常。"""

    async def scenario() -> None:
        router = MessageRouter()

        result = await router.dispatch({"type": "nothing.registered"}, "device_1")

        assert result is not None
        assert result["ok"] is False
        assert result["error"]["code"] == "UNKNOWN_MESSAGE_TYPE"

    asyncio.run(scenario())


def test_dispatch_missing_type_field_returns_error() -> None:
    """消息缺少合法的 type 字段时返回 INVALID_MESSAGE_TYPE 错误。"""

    async def scenario() -> None:
        router = MessageRouter()

        result = await router.dispatch({"request_id": "req_1"}, "device_1")

        assert result is not None
        assert result["error"]["code"] == "INVALID_MESSAGE_TYPE"

    asyncio.run(scenario())


def test_dispatch_handler_exception_returns_internal_error() -> None:
    """handler 抛异常时不传播,转成 INTERNAL_ERROR 错误信封。"""

    async def scenario() -> None:
        router = MessageRouter()

        async def broken_handler(raw_message: dict[str, Any], device_id: str) -> dict[str, Any]:
            raise RuntimeError("boom")

        router.register("broken.command", broken_handler)

        result = await router.dispatch({"type": "broken.command"}, "device_1")

        assert result is not None
        assert result["error"]["code"] == "INTERNAL_ERROR"

    asyncio.run(scenario())
