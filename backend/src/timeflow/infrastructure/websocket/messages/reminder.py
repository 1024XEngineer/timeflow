"""提醒下发、系统引用检查与删除相关消息。"""

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
    type: Literal["reminder.control.ack"] = "reminder.control.ack"
    schedule_id: str
    ok: bool
    error: ErrorDetail | None = None


class SystemRefsCheck(BaseModel):
    """下发提醒或删除指令前,先确认系统侧对象是否仍存在。"""

    type: Literal["system.refs.check"] = "system.refs.check"
    schedule_id: str
    system_schedule_ref_id: str | None = None
    system_alarm_ref_id: str | None = None
    reason: str


class SystemRefsCheckResult(BaseModel):
    type: Literal["system.refs.check.result"] = "system.refs.check.result"
    schedule_id: str
    ok: bool
    system_schedule_ref_id: str | None = None
    system_schedule_exists: bool | None = None
    system_alarm_ref_id: str | None = None
    system_alarm_exists: bool | None = None
    checked_at: str | None = None
    error: ErrorDetail | None = None


class SystemScheduleDelete(BaseModel):
    type: Literal["system.schedule.delete"] = "system.schedule.delete"
    schedule_id: str
    system_schedule_ref_id: str
    reason: str


class SystemScheduleDeleteAck(BaseModel):
    type: Literal["system.schedule.delete.ack"] = "system.schedule.delete.ack"
    schedule_id: str
    ok: bool
    system_schedule_ref_id: str
    error: ErrorDetail | None = None


class SystemAlarmDelete(BaseModel):
    type: Literal["system.alarm.delete"] = "system.alarm.delete"
    schedule_id: str
    system_alarm_ref_id: str
    reason: str


class SystemAlarmDeleteAck(BaseModel):
    type: Literal["system.alarm.delete.ack"] = "system.alarm.delete.ack"
    schedule_id: str
    ok: bool
    system_alarm_ref_id: str
    error: ErrorDetail | None = None


class ScheduleConfirmed(BaseModel):
    """客户端告知服务端:用户已在 App 内确认该日程完成。"""

    type: Literal["schedule.confirmed"] = "schedule.confirmed"
    schedule_id: str
    confirmed: bool
    timestamp: str


class ScheduleConfirmedAck(BaseModel):
    type: Literal["schedule.confirmed.ack"] = "schedule.confirmed.ack"
    schedule_id: str
    ok: bool
    error: ErrorDetail | None = None
