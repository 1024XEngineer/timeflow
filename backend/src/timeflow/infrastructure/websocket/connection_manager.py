"""按 device_id 追踪活跃 WS 连接,支持服务端主动推送(尽力而为,不保证送达)。"""

import asyncio
from typing import Any, Protocol


class _Sendable(Protocol):
    async def send_json(self, data: Any) -> None: ...

    async def send_bytes(self, data: bytes) -> None: ...


class ConnectionManager:
    """注册活跃设备连接,并向指定设备推送消息。"""

    def __init__(self) -> None:
        self._connections: dict[str, _Sendable] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def register(self, device_id: str, connection: _Sendable) -> None:
        """注册某个设备当前的活跃连接,替换掉之前的连接(如果有)。"""
        self._connections[device_id] = connection

    def unregister(self, device_id: str, connection: _Sendable) -> None:
        """移除某个设备的连接记录,仅当当前记录确实是这个连接实例时才移除。

        避免旧连接晚于新连接退出时,把重连之后已经生效的新连接误删掉。
        """
        if self._connections.get(device_id) is connection:
            self._connections.pop(device_id, None)

    def is_connected(self, device_id: str) -> bool:
        """返回某个设备当前是否有活跃连接。"""
        return device_id in self._connections

    def lock_for(self, device_id: str) -> asyncio.Lock:
        """返回该 device_id 专属的发送锁,不存在时惰性创建;跨重连复用同一把锁。

        WebSocket.send() 底层没有并发保护,worker 和收发循环自己都可能往同一条
        连接发消息,任何写入方都必须先拿到这把锁再发送。
        """
        return self._locks.setdefault(device_id, asyncio.Lock())

    async def send(self, device_id: str, message: dict[str, Any]) -> bool:
        """向指定设备推送一条消息。设备不在线时返回 False,不抛异常。"""
        connection = self._connections.get(device_id)
        if connection is None:
            return False
        async with self.lock_for(device_id):
            if self._connections.get(device_id) is not connection:
                return False
            await connection.send_json(message)
        return True
    async def send_audio(
        self,
        device_id: str,
        start_message: dict[str, Any],
        audio_data: bytes,
        end_message: dict[str, Any],
        *,
        preceding_message: dict[str, Any] | None = None,
        chunk_size: int = 64 * 1024,
    ) -> bool:
        """原子下发提醒控制消息和一段完整音频流。"""
        if chunk_size <= 0:
            raise ValueError("chunk_size must be greater than zero")
        connection = self._connections.get(device_id)
        if connection is None:
            return False

        async with self.lock_for(device_id):
            if self._connections.get(device_id) is not connection:
                return False
            if preceding_message is not None:
                await connection.send_json(preceding_message)
            await connection.send_json(start_message)
            for offset in range(0, len(audio_data), chunk_size):
                await connection.send_bytes(audio_data[offset : offset + chunk_size])
            await connection.send_json(end_message)
        return True
