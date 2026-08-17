"""受保护的账号日程全量快照 HTTP 适配器。"""

import logging
from typing import Annotated, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Request, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from timeflow.business.calendar import (
    AccountScheduleSnapshot,
    OccurrenceOverrideAction,
    ReminderDispositionState,
    ReminderStrength,
    ReminderType,
    ScheduleKind,
    ScheduleSnapshotReader,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.gateway.auth_diagnostics import log_sanitized_exception
from timeflow.gateway.http.auth import AuthErrorEnvelope
from timeflow.gateway.http.dependencies import (
    AuthenticatedAccount,
    AuthenticatedAccountDependency,
)

logger = logging.getLogger(__name__)

_INTERNAL_CODE = "SCHEDULE_SNAPSHOT_INTERNAL_ERROR"
_INTERNAL_MESSAGE = "Schedule snapshot unavailable"
_BEARER_SECURITY = HTTPBearer(auto_error=False)


class ScheduleHttpSnapshot(BaseModel):
    """一个已提交日程的 HTTP 快照。"""

    model_config = ConfigDict(frozen=True, from_attributes=True, strict=True)

    id: str = Field(min_length=1)
    account_id: str = Field(min_length=1)
    schedule_type: ScheduleType
    schedule_kind: ScheduleKind
    title: str = Field(min_length=1, max_length=255)
    is_all_day: bool
    start_time: AwareDatetime | None
    end_time: AwareDatetime | None
    timezone: str = Field(min_length=1, max_length=64)
    recurrence_rule: str | None
    location_name: str | None
    latitude: float | None = Field(ge=-90, le=90)
    longitude: float | None = Field(ge=-180, le=180)
    reminder_type: ReminderType | None
    reminder_trigger_at: AwareDatetime | None
    reminder_offset_minutes: int | None = Field(ge=0)
    reminder_strength: ReminderStrength | None
    reminder_disposition_state: ReminderDispositionState | None
    status: ScheduleStatus
    revision: int = Field(ge=1)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    deleted_at: AwareDatetime | None

    @model_validator(mode="after")
    def validate_shared_contract(self) -> Self:
        """Reject a damaged row that cannot satisfy the shared HTTP contract."""
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("timezone must be a valid IANA timezone") from error

        if self.schedule_type is ScheduleType.TIME:
            if self.start_time is None:
                raise ValueError("time schedules require start_time")
        elif self.start_time is not None:
            raise ValueError("location schedules require a null start_time")

        if self.end_time is not None and (
            self.start_time is None or self.end_time <= self.start_time
        ):
            raise ValueError("end_time must be later than start_time")

        if self.schedule_kind is ScheduleKind.RECURRING:
            if self.recurrence_rule is None or not self.recurrence_rule.strip():
                raise ValueError("recurring schedules require recurrence_rule")
        elif self.recurrence_rule is not None:
            raise ValueError("one-time schedules require a null recurrence_rule")

        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("latitude and longitude must be supplied together")

        self._validate_reminder_contract()

        if self.status is ScheduleStatus.ACTIVE and self.deleted_at is not None:
            raise ValueError("active schedules require a null deleted_at")
        if self.status is ScheduleStatus.DELETED and self.deleted_at is None:
            raise ValueError("deleted schedules require deleted_at")
        return self

    def _validate_reminder_contract(self) -> None:
        reminder_fields = (
            self.reminder_trigger_at,
            self.reminder_offset_minutes,
            self.reminder_strength,
            self.reminder_disposition_state,
        )
        if self.reminder_type is None:
            if any(value is not None for value in reminder_fields):
                raise ValueError("reminder fields require reminder_type")
            return
        if self.reminder_strength is None:
            raise ValueError("reminder_strength is required")

        if self.reminder_type is ReminderType.AT_TIME:
            if (
                self.schedule_type is not ScheduleType.TIME
                or self.start_time is None
                or self.reminder_trigger_at is None
                or self.reminder_offset_minutes is not None
            ):
                raise ValueError("invalid at_time reminder fields")
            return

        if self.reminder_type is ReminderType.BEFORE_START:
            if (
                self.schedule_type is not ScheduleType.TIME
                or self.start_time is None
                or self.reminder_trigger_at is not None
                or self.reminder_offset_minutes is None
            ):
                raise ValueError("invalid before_start reminder fields")
            return

        if (
            self.latitude is None
            or self.longitude is None
            or self.reminder_trigger_at is not None
            or self.reminder_offset_minutes is not None
        ):
            raise ValueError("invalid location reminder fields")


class ScheduleOccurrenceOverrideHttpSnapshot(BaseModel):
    """一个已提交周期例外的 HTTP 快照。"""

    model_config = ConfigDict(frozen=True, from_attributes=True, strict=True)

    id: str = Field(min_length=1)
    schedule_id: str = Field(min_length=1)
    occurrence_start: AwareDatetime
    action: OccurrenceOverrideAction
    replacement_schedule_id: str | None
    created_at: AwareDatetime
    updated_at: AwareDatetime


class ScheduleSnapshotResponse(BaseModel):
    """账号云端日程全量快照响应。"""

    model_config = ConfigDict(frozen=True, extra="forbid")

    schedules: tuple[ScheduleHttpSnapshot, ...]
    occurrence_overrides: tuple[ScheduleOccurrenceOverrideHttpSnapshot, ...]


class ScheduleSnapshotErrorDetail(BaseModel):
    """快照接口的稳定内部错误。"""

    model_config = ConfigDict(frozen=True)

    code: str
    message: str


class ScheduleSnapshotErrorEnvelope(BaseModel):
    """快照接口错误外壳。"""

    model_config = ConfigDict(frozen=True)

    error: ScheduleSnapshotErrorDetail


def _build_response(
    account_id: str,
    snapshot: AccountScheduleSnapshot,
) -> ScheduleSnapshotResponse:
    """转换并验证一个不可部分返回的账号快照。"""
    schedules = tuple(ScheduleHttpSnapshot.model_validate(item) for item in snapshot.schedules)
    overrides = tuple(
        ScheduleOccurrenceOverrideHttpSnapshot.model_validate(item)
        for item in snapshot.occurrence_overrides
    )

    schedules_by_id: dict[str, ScheduleHttpSnapshot] = {}
    for schedule in schedules:
        if schedule.id in schedules_by_id:
            raise ValueError("duplicate schedule id")
        if schedule.account_id != account_id:
            raise ValueError("schedule account mismatch")
        schedules_by_id[schedule.id] = schedule

    override_ids: set[str] = set()
    occurrence_keys: set[tuple[str, AwareDatetime]] = set()
    for occurrence_override in overrides:
        if occurrence_override.id in override_ids:
            raise ValueError("duplicate occurrence override id")
        override_ids.add(occurrence_override.id)

        occurrence_key = (
            occurrence_override.schedule_id,
            occurrence_override.occurrence_start,
        )
        if occurrence_key in occurrence_keys:
            raise ValueError("duplicate schedule occurrence override")
        occurrence_keys.add(occurrence_key)

        parent = schedules_by_id.get(occurrence_override.schedule_id)
        if parent is None or parent.schedule_kind is not ScheduleKind.RECURRING:
            raise ValueError("invalid occurrence override parent")

        replacement_id = occurrence_override.replacement_schedule_id
        if occurrence_override.action is OccurrenceOverrideAction.CANCEL:
            if replacement_id is not None:
                raise ValueError("cancel override cannot have replacement")
        elif replacement_id is None or replacement_id not in schedules_by_id:
            raise ValueError("replace override requires a valid replacement")

    return ScheduleSnapshotResponse(schedules=schedules, occurrence_overrides=overrides)


def _internal_error_response(error: Exception) -> JSONResponse:
    """记录脱敏诊断并返回稳定且不泄密的 500。"""
    log_sanitized_exception(
        logger,
        error,
        event_prefix="schedule_snapshot_event",
        error_code=_INTERNAL_CODE,
        status_code=500,
        message="schedule snapshot unavailable",
    )
    envelope = ScheduleSnapshotErrorEnvelope(
        error=ScheduleSnapshotErrorDetail(code=_INTERNAL_CODE, message=_INTERNAL_MESSAGE)
    )
    return JSONResponse(status_code=500, content=envelope.model_dump())


def create_schedule_snapshot_router(
    reader: ScheduleSnapshotReader,
    authenticated_account: AuthenticatedAccountDependency,
) -> APIRouter:
    """构建只信任已验证 Token 账号的快照路由。"""
    router = APIRouter()

    def authenticate_snapshot_account(
        request: Request,
        _credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(_BEARER_SECURITY),
        ],
    ) -> AuthenticatedAccount:
        # HTTPBearer declares the OpenAPI scheme; this shared dependency alone verifies the token.
        return authenticated_account(request.headers.get("Authorization"))

    @router.get(
        "/api/v1/schedule/snapshot",
        response_model=ScheduleSnapshotResponse,
        responses={
            401: {"model": AuthErrorEnvelope},
            500: {"model": ScheduleSnapshotErrorEnvelope},
        },
    )
    def get_schedule_snapshot(
        account: Annotated[AuthenticatedAccount, Depends(authenticate_snapshot_account)],
    ) -> JSONResponse:
        try:
            snapshot = reader.get_account_snapshot(account_id=account.account_id)
            response = _build_response(account.account_id, snapshot)
            return JSONResponse(status_code=200, content=response.model_dump(mode="json"))
        except Exception as error:
            return _internal_error_response(error)

    return router


__all__ = [
    "ScheduleHttpSnapshot",
    "ScheduleOccurrenceOverrideHttpSnapshot",
    "ScheduleSnapshotErrorDetail",
    "ScheduleSnapshotErrorEnvelope",
    "ScheduleSnapshotResponse",
    "create_schedule_snapshot_router",
]
