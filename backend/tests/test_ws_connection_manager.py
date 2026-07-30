"""ConnectionManager 的单元测试。"""

import asyncio
from typing import Any

from timeflow.infrastructure.websocket.connection_manager import ConnectionManager


class _FakeConnection:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


class _RaceDetectingConnection:
    """记录并发中"同时在发送"的最大数量,用来验证发送确实被串行化。"""

    def __init__(self) -> None:
        self.max_concurrent = 0
        self._current = 0

    async def send_json(self, data: dict[str, Any]) -> None:
        self._current += 1
        self.max_concurrent = max(self.max_concurrent, self._current)
        await asyncio.sleep(0)  # 主动让出控制权,给并发调用制造交织的机会
        self._current -= 1


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
        manager.unregister("device_1", connection)

        assert manager.is_connected("device_1") is False
        delivered = await manager.send("device_1", {"type": "reminder.control"})
        assert delivered is False

    asyncio.run(scenario())


def test_unregister_does_not_remove_a_newer_reconnected_connection() -> None:
    """旧连接晚于新连接退出时,unregister 不能把重连后生效的新连接误删。"""

    async def scenario() -> None:
        manager = ConnectionManager()
        old_connection = _FakeConnection()
        new_connection = _FakeConnection()

        manager.register("device_1", old_connection)
        manager.register("device_1", new_connection)  # 设备用同一个 device_id 重连
        manager.unregister("device_1", old_connection)  # 旧连接才检测到断开、迟一步清理

        assert manager.is_connected("device_1") is True
        delivered = await manager.send("device_1", {"type": "reminder.control"})
        assert delivered is True
        assert new_connection.sent == [{"type": "reminder.control"}]

    asyncio.run(scenario())


def test_lock_for_returns_same_lock_for_same_device_id() -> None:
    """同一个 device_id 反复调用 lock_for 拿到的是同一把锁,跨重连也复用。"""

    async def scenario() -> None:
        manager = ConnectionManager()

        lock_a = manager.lock_for("device_1")
        lock_b = manager.lock_for("device_1")

        assert lock_a is lock_b

    asyncio.run(scenario())


def test_send_serializes_concurrent_calls_to_the_same_device() -> None:
    """并发对同一个设备调用 send() 不会交织,一次只有一个真正在发送。"""

    async def scenario() -> None:
        manager = ConnectionManager()
        connection = _RaceDetectingConnection()
        manager.register("device_1", connection)

        await asyncio.gather(
            manager.send("device_1", {"type": "a"}),
            manager.send("device_1", {"type": "b"}),
        )

        assert connection.max_concurrent == 1

    asyncio.run(scenario())
