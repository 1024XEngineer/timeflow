"""位置上报消息。"""

from typing import Literal

from pydantic import BaseModel

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


class LocationReport(BaseModel):
    """客户端上报当前位置,用于服务端判断是否命中地理围栏。"""

    type: Literal["location.report"] = "location.report"
    schedule_scope: str
    latitude: float
    longitude: float
    accuracy: float
    timestamp: str


class LocationReportAck(BaseModel):
    type: Literal["location.report.ack"] = "location.report.ack"
    ok: bool
    error: ErrorDetail | None = None
