"""ConnectionManager 的单元测试。"""

import asyncio
from typing import Any

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager


class _FakeConnection:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


def test_send_pushes_to_registered_connection() -> None:
    """已注册设备能收到 send() 推送的消息,返回 True。"""

    async def scenario() -> None:
        manager = ConnectionManager()
        connection = _FakeConnection()
        manager.register("device_1", connection)

        delivered = await manager.send("device_1", {"type": "reminder.control"})

        assert delivered is True
        assert connection.sent == [{"type": "reminder.control"}]

    asyncio.run(scenario())


def test_send_to_unregistered_device_returns_false() -> None:
    """向不在线的设备 send() 不抛异常,返回 False。"""

    async def scenario() -> None:
        manager = ConnectionManager()

        delivered = await manager.send("missing_device", {"type": "reminder.control"})

        assert delivered is False

    asyncio.run(scenario())


def test_unregister_stops_further_delivery() -> None:
    """unregister 之后该设备不再是"在线",send() 返回 False。"""

    async def scenario() -> None:
        manager = ConnectionManager()
        connection = _FakeConnection()
        manager.register("device_1", connection)
        manager.unregister("device_1")

        assert manager.is_connected("device_1") is False
        delivered = await manager.send("device_1", {"type": "reminder.control"})
        assert delivered is False

    asyncio.run(scenario())


def test_broadcast_sends_to_all_connections() -> None:
    """broadcast() 把同一条消息推给所有在线设备。"""

    async def scenario() -> None:
        manager = ConnectionManager()
        first, second = _FakeConnection(), _FakeConnection()
        manager.register("device_1", first)
        manager.register("device_2", second)

        await manager.broadcast({"type": "reminder.control"})

        assert first.sent == [{"type": "reminder.control"}]
        assert second.sent == [{"type": "reminder.control"}]

    asyncio.run(scenario())
