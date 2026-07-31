"""日程创建/更新/查询相关消息。"""

from typing import Literal

from pydantic import BaseModel, Field

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


class ScheduleUpsertPayload(BaseModel):
    """创建或编辑日程的请求 payload。"""

    schedule_id: str | None = None
    source_mode: str
    schedule_type: str
    title: str
    notes: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    timezone: str | None = None
    location_name: str | None = None
    location_address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    geofence_radius_meters: int | None = None
    geofence_armed: bool | None = None
    time_remind_offset_minutes: int | None = None


class ScheduleUpsertCommand(BaseModel):
    type: Literal["schedule.upsert.command"] = "schedule.upsert.command"
    request_id: str
    payload: ScheduleUpsertPayload


class ScheduleConflict(BaseModel):
    """冲突提示里的既有日程摘要。"""

    schedule_id: str
    title: str
    start_time: str
    end_time: str | None = None


class ScheduleUpsertResultPayload(BaseModel):
    schedule_id: str
    schedule_type: str
    status: str
    conflicts: list[ScheduleConflict] = Field(default_factory=list)
    geofence_armed: bool


class ScheduleUpsertResult(BaseModel):
    type: Literal["schedule.upsert.result"] = "schedule.upsert.result"
    request_id: str
    ok: Literal[True] = True
    payload: ScheduleUpsertResultPayload


class ScheduleUpsertError(BaseModel):
    type: Literal["schedule.upsert.error"] = "schedule.upsert.error"
    request_id: str
    ok: Literal[False] = False
    error: ErrorDetail


class ScheduleListQueryPayload(BaseModel):
    status: str | None = None
    include_deleted: bool = False


class ScheduleListQuery(BaseModel):
    type: Literal["schedule.list.query"] = "schedule.list.query"
    request_id: str
    payload: ScheduleListQueryPayload


class ScheduleSummary(BaseModel):
    """`schedule.list.result` 里单条日程的完整字段,对应 `schedules` 表。"""

    id: str
    user_id: str
    source_mode: str
    schedule_type: str
    status: str
    title: str
    notes: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    timezone: str | None = None
    location_name: str | None = None
    location_address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    geofence_radius_meters: int
    geofence_armed: bool
    time_remind_offset_minutes: int
    time_triggered_at: str | None = None
    geo_triggered_at: str | None = None
    system_schedule_ref_id: str | None = None
    system_alarm_ref_id: str | None = None
    created_at: str
    updated_at: str


class ScheduleListResultPayload(BaseModel):
    schedules: list[ScheduleSummary]


class ScheduleListResult(BaseModel):
    type: Literal["schedule.list.result"] = "schedule.list.result"
    request_id: str
    ok: Literal[True] = True
    payload: ScheduleListResultPayload


class ScheduleListError(BaseModel):
    type: Literal["schedule.list.error"] = "schedule.list.error"
    request_id: str
    ok: Literal[False] = False
    error: ErrorDetail


class ScheduleDeleted(BaseModel):
    """客户端主动告知服务端:用户删除了这条日程。"""

    type: Literal["schedule.deleted"] = "schedule.deleted"
    schedule_id: str
    deleted: Literal[True]
    timestamp: str


class ScheduleDeletedAck(BaseModel):
    """`schedule.deleted` 的响应;成功/失败共用同一个消息类型,靠 `ok` 区分。"""

    type: Literal["schedule.deleted.ack"] = "schedule.deleted.ack"
    schedule_id: str
    ok: bool
    error: ErrorDetail | None = None
