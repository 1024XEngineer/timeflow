"""按 device_id 追踪活跃 WS 连接,支持服务端主动推送(尽力而为,不保证送达)。"""

from typing import Any, Protocol


class _Sendable(Protocol):
    async def send_json(self, data: Any) -> None: ...


class ConnectionManager:
    """注册活跃设备连接,并向指定设备推送消息。"""

    def __init__(self) -> None:
        self._connections: dict[str, _Sendable] = {}

    def register(self, device_id: str, connection: _Sendable) -> None:
        """注册某个设备当前的活跃连接,替换掉之前的连接(如果有)。"""
        self._connections[device_id] = connection

    def unregister(self, device_id: str) -> None:
        """移除某个设备的连接记录(如果存在)。"""
        self._connections.pop(device_id, None)

    def is_connected(self, device_id: str) -> bool:
        """返回某个设备当前是否有活跃连接。"""
        return device_id in self._connections

    async def send(self, device_id: str, message: dict[str, Any]) -> bool:
        """向指定设备推送一条消息。设备不在线时返回 False,不抛异常。"""
        connection = self._connections.get(device_id)
        if connection is None:
            return False
        await connection.send_json(message)
        return True
