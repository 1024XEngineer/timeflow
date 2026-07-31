"""WebSocket handlers for schedule commands and queries."""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from timeflow.business.reminders import ReminderAudioGenerationPort
from timeflow.business.schedules import (
    ScheduleListQuery as BusinessScheduleListQuery,
)
from timeflow.business.schedules import (
    ScheduleNotFoundError,
    ScheduleRecord,
    ScheduleService,
    ScheduleValidationError,
)
from timeflow.business.schedules import ScheduleUpsertCommand as BusinessScheduleUpsertCommand
from timeflow.infrastructure.websocket.envelope import build_error_envelope
from timeflow.infrastructure.websocket.messages.envelope import ErrorDetail
from timeflow.infrastructure.websocket.messages.schedule import (
    ScheduleConflict as ScheduleConflictMessage,
)
from timeflow.infrastructure.websocket.messages.schedule import (
    ScheduleDeleted,
    ScheduleDeletedAck,
    ScheduleListQuery,
    ScheduleListResult,
    ScheduleListResultPayload,
    ScheduleSummary,
    ScheduleUpsertCommand,
    ScheduleUpsertResult,
    ScheduleUpsertResultPayload,
)
from timeflow.infrastructure.websocket.reminder_audio import ReminderAudioGenerationTracker

logger = logging.getLogger(__name__)


class ScheduleWebSocketHandlers:
    """Adapt schedule WS messages to business service calls."""

    def __init__(
        self,
        service: ScheduleService,
        reminder_audio_service: ReminderAudioGenerationPort | None = None,
        generation_tracker: ReminderAudioGenerationTracker | None = None,
    ) -> None:
        self._service = service
        self._reminder_audio_service = reminder_audio_service
        # 生成任务的注册表交给 tracker 统一持有,`ReminderAudioSender` 下发提醒前
        # 要靠它判断"这条日程的音频是不是还在生成中",所以不能是本类私有状态。
        self._generation_tracker = generation_tracker or ReminderAudioGenerationTracker(
            reminder_audio_service
        )

    async def handle_upsert(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        """Handle `schedule.upsert.command`."""
        del device_id
        request_id = self._extract_request_id(raw_message)
        try:
            message = ScheduleUpsertCommand.model_validate(raw_message)
            payload = message.payload
            result = self._service.upsert(
                BusinessScheduleUpsertCommand(
                    schedule_id=payload.schedule_id,
                    source_mode=payload.source_mode,
                    schedule_type=payload.schedule_type,
                    title=payload.title,
                    notes=payload.notes,
                    start_time=payload.start_time,
                    end_time=payload.end_time,
                    timezone=payload.timezone,
                    location_name=payload.location_name,
                    location_address=payload.location_address,
                    latitude=payload.latitude,
                    longitude=payload.longitude,
                    geofence_radius_meters=payload.geofence_radius_meters,
                    geofence_armed=payload.geofence_armed,
                    time_remind_offset_minutes=payload.time_remind_offset_minutes,
                )
            )
        except ValidationError as exc:
            return self._validation_error("schedule.upsert.error", request_id, exc.errors())
        except ScheduleValidationError as exc:
            return self._business_validation_error("schedule.upsert.error", request_id, exc)
        except ScheduleNotFoundError:
            return build_error_envelope(
                "schedule.upsert.error",
                request_id,
                "SCHEDULE_NOT_FOUND",
                "日程不存在",
            )

        self._submit_audio_generation(result.schedule)

        response = ScheduleUpsertResult(
            request_id=message.request_id,
            payload=ScheduleUpsertResultPayload(
                schedule_id=result.schedule_id,
                schedule_type=result.schedule_type,
                status=result.status,
                conflicts=[
                    ScheduleConflictMessage(
                        schedule_id=conflict.schedule_id,
                        title=conflict.title,
                        start_time=conflict.start_time,
                        end_time=conflict.end_time,
                    )
                    for conflict in result.conflicts
                ],
                geofence_armed=result.geofence_armed,
            ),
        )
        return response.model_dump()

    async def aclose(self) -> None:
        """Cancel pending TTS generation tasks during application shutdown."""
        await self._generation_tracker.aclose()

    async def _delete_audio(self, schedule_id: str) -> None:
        if self._reminder_audio_service is None:
            return
        await self._generation_tracker.discard(schedule_id)
        await self._reminder_audio_service.delete(schedule_id)

    def _submit_audio_generation(self, schedule: ScheduleRecord) -> None:
        self._generation_tracker.submit(schedule)

    async def handle_list(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        """Handle `schedule.list.query`."""
        del device_id
        request_id = self._extract_request_id(raw_message)
        try:
            message = ScheduleListQuery.model_validate(raw_message)
            result = self._service.list(
                BusinessScheduleListQuery(
                    status=message.payload.status,
                    include_deleted=message.payload.include_deleted,
                )
            )
        except ValidationError as exc:
            return self._validation_error("schedule.list.error", request_id, exc.errors())
        except ScheduleValidationError as exc:
            return self._business_validation_error("schedule.list.error", request_id, exc)

        response = ScheduleListResult(
            request_id=message.request_id,
            payload=ScheduleListResultPayload(
                schedules=[
                    ScheduleSummary(
                        id=schedule.id,
                        user_id=schedule.user_id,
                        source_mode=schedule.source_mode,
                        schedule_type=schedule.schedule_type,
                        status=schedule.status,
                        title=schedule.title,
                        notes=schedule.notes,
                        start_time=schedule.start_time,
                        end_time=schedule.end_time,
                        timezone=schedule.timezone,
                        location_name=schedule.location_name,
                        location_address=schedule.location_address,
                        latitude=schedule.latitude,
                        longitude=schedule.longitude,
                        geofence_radius_meters=schedule.geofence_radius_meters,
                        geofence_armed=schedule.geofence_armed,
                        time_remind_offset_minutes=schedule.time_remind_offset_minutes,
                        time_triggered_at=schedule.time_triggered_at,
                        geo_triggered_at=schedule.geo_triggered_at,
                        system_schedule_ref_id=schedule.system_schedule_ref_id,
                        system_alarm_ref_id=schedule.system_alarm_ref_id,
                        created_at=schedule.created_at,
                        updated_at=schedule.updated_at,
                    )
                    for schedule in result.schedules
                ]
            ),
        )
        return response.model_dump()

    async def handle_deleted(
        self,
        raw_message: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        """Handle `schedule.deleted`。成功/失败共用同一个响应类型,靠 `ok` 区分,
        不像 upsert/list 那样走 request_id 关联的 result/error 分支。"""
        del device_id
        try:
            message = ScheduleDeleted.model_validate(raw_message)
        except ValidationError:
            raw_schedule_id = raw_message.get("schedule_id")
            return ScheduleDeletedAck(
                schedule_id=raw_schedule_id if isinstance(raw_schedule_id, str) else "",
                ok=False,
                error=ErrorDetail(code="VALIDATION_ERROR", message="请求参数不合法"),
            ).model_dump(exclude_none=True)

        try:
            self._service.delete(message.schedule_id)
        except ScheduleNotFoundError:
            return ScheduleDeletedAck(
                schedule_id=message.schedule_id,
                ok=False,
                error=ErrorDetail(
                    code="SCHEDULE_DELETE_FAILED",
                    message="日程删除失败",
                    details={"reason": "schedule_not_found"},
                ),
            ).model_dump(exclude_none=True)
        except ScheduleValidationError as exc:
            return ScheduleDeletedAck(
                schedule_id=message.schedule_id,
                ok=False,
                error=ErrorDetail(
                    code="VALIDATION_ERROR",
                    message="请求参数不合法",
                    details={"field": exc.field, "reason": exc.reason},
                ),
            ).model_dump(exclude_none=True)

        await self._delete_audio(message.schedule_id)
        return ScheduleDeletedAck(schedule_id=message.schedule_id, ok=True).model_dump(
            exclude_none=True
        )

    @staticmethod
    def _extract_request_id(raw_message: dict[str, Any]) -> str | None:
        value = raw_message.get("request_id")
        return value if isinstance(value, str) else None

    @staticmethod
    def _validation_error(
        message_type: str,
        request_id: str | None,
        errors: list[Any],
    ) -> dict[str, Any]:
        return build_error_envelope(
            message_type,
            request_id,
            "VALIDATION_ERROR",
            "请求参数不合法",
            {"errors": errors},
        )

    @staticmethod
    def _business_validation_error(
        message_type: str,
        request_id: str | None,
        exc: ScheduleValidationError,
    ) -> dict[str, Any]:
        return build_error_envelope(
            message_type,
            request_id,
            "VALIDATION_ERROR",
            "请求参数不合法",
            {"field": exc.field, "reason": exc.reason},
        )


__all__ = ["ScheduleWebSocketHandlers"]
