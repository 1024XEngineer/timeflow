"""语音流式识别相关消息。"""

from typing import Literal

from pydantic import BaseModel

from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail


class VoiceStreamStartPayload(BaseModel):
    audio_format: str
    sample_rate_hz: int
    channels: int


class VoiceStreamStart(BaseModel):
    """客户端开始一次语音流。"""

    type: Literal["voice.stream.start"] = "voice.stream.start"
    request_id: str
    payload: VoiceStreamStartPayload


class VoiceStreamStartedPayload(BaseModel):
    stream_id: str
    job_id: str


class VoiceStreamStarted(BaseModel):
    type: Literal["voice.stream.started"] = "voice.stream.started"
    request_id: str
    ok: Literal[True] = True
    payload: VoiceStreamStartedPayload


class VoiceStreamEndPayload(BaseModel):
    stream_id: str


class VoiceStreamEnd(BaseModel):
    """客户端结束当前语音流。"""

    type: Literal["voice.stream.end"] = "voice.stream.end"
    request_id: str
    payload: VoiceStreamEndPayload


class VoiceStreamEndedPayload(BaseModel):
    stream_id: str
    job_id: str
    status: str


class VoiceStreamEnded(BaseModel):
    type: Literal["voice.stream.ended"] = "voice.stream.ended"
    request_id: str
    ok: Literal[True] = True
    payload: VoiceStreamEndedPayload


class VoiceStreamError(BaseModel):
    type: Literal["voice.stream.error"] = "voice.stream.error"
    request_id: str
    ok: Literal[False] = False
    error: ErrorDetail


class VoiceParseDraft(BaseModel):
    """语音结构化草稿,字段对应最终 `schedule.upsert` 的候选值。"""

    schedule_type: str
    title: str
    start_time: str | None = None
    end_time: str | None = None
    timezone: str | None = None
    location_name: str | None = None
    geofence_radius_meters: int | None = None
    time_remind_offset_minutes: int | None = None


class VoiceParseResult(BaseModel):
    """语音结构化结果推送,成功和失败共用同一个消息 type,靠 `status` 区分。"""

    type: Literal["voice.parse.result"] = "voice.parse.result"
    request_id: str
    job_id: str
    status: str
    draft: VoiceParseDraft | None = None
    missing_fields: list[str] | None = None
    ambiguous_fields: list[str] | None = None
    needs_confirmation: bool | None = None
    error: ErrorDetail | None = None
