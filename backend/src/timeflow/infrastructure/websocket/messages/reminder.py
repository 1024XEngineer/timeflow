"""提醒下发相关消息。"""

from typing import Literal

from pydantic import BaseModel

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


class ReminderControl(BaseModel):
    """服务端主动下发:该提醒了,具体展示方式由客户端决定。"""

    type: Literal["reminder.control"] = "reminder.control"
    schedule_id: str
    reason: str
    action: str


class ReminderControlAck(BaseModel):
    """客户端执行提醒后回传的确认。"""

    type: Literal["reminder.control.ack"] = "reminder.control.ack"
    schedule_id: str
    ok: bool
    error: ErrorDetail | None = None
