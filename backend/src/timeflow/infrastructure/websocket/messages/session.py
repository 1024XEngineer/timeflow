"""连接建立握手消息。"""

from typing import Literal

from pydantic import BaseModel

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


class SessionHello(BaseModel):
    """客户端连接后发送的握手消息。"""

    type: Literal["session.hello"] = "session.hello"
    device_id: str
    app_version: str


class SessionReady(BaseModel):
    """服务端确认会话建立成功。"""

    type: Literal["session.ready"] = "session.ready"
    device_id: str
    server_time: str


class SessionError(BaseModel):
    """服务端拒绝建立会话。"""

    type: Literal["session.error"] = "session.error"
    ok: Literal[False] = False
    error: ErrorDetail
