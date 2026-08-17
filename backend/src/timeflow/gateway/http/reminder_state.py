"""HTTP adapter for syncing a schedule reminder's final confirmed state."""

import logging
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, field_validator
from starlette.responses import Response

from timeflow.business.calendar import (
    ReminderDispositionConfirmer,
    ReminderDispositionState,
    ScheduleBusinessError,
    ScheduleErrorCode,
)
from timeflow.gateway.auth_diagnostics import log_sanitized_exception
from timeflow.gateway.http.dependencies import (
    AuthenticatedAccount,
    AuthenticatedAccountDependency,
)

logger = logging.getLogger(__name__)


class ReminderStateRequest(BaseModel):
    """Only the schedule identity and final confirmed state are client-controlled."""

    model_config = ConfigDict(strict=True, extra="forbid")

    schedule_id: str
    disposition_state: Literal["confirmed"]

    @field_validator("schedule_id")
    @classmethod
    def validate_schedule_id(cls, value: str) -> str:
        schedule_id = value.strip()
        if not schedule_id:
            raise ValueError("schedule_id must not be blank")
        if len(schedule_id) > 64:
            raise ValueError("schedule_id must not exceed 64 characters")
        return schedule_id


class ReminderStateResponse(BaseModel):
    """Server-authoritative final reminder state."""

    model_config = ConfigDict(frozen=True)

    schedule_id: str
    disposition_state: ReminderDispositionState
    updated_at: datetime


class ReminderStateErrorDetail(BaseModel):
    """Stable error fields for reminder-state sync."""

    model_config = ConfigDict(frozen=True)

    code: str
    message: str


class ReminderStateErrorEnvelope(BaseModel):
    """Stable error response for reminder-state sync."""

    model_config = ConfigDict(frozen=True)

    error: ReminderStateErrorDetail


class ReminderStateInvalidRequestResponse(BaseModel):
    """Stable validation response that never reflects rejected client input."""

    model_config = ConfigDict(frozen=True)

    detail: Literal["Invalid request body"] = "Invalid request body"


class _ReminderStateRoute(APIRoute):
    """Return a stable validation response without reflecting rejected input."""

    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original_handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            try:
                return await original_handler(request)
            except RequestValidationError:
                response = ReminderStateInvalidRequestResponse()
                return JSONResponse(
                    status_code=422,
                    content=response.model_dump(),
                )

        return route_handler


def create_reminder_state_router(
    confirmer: ReminderDispositionConfirmer,
    authenticated_account: AuthenticatedAccountDependency,
) -> APIRouter:
    """Build the protected final reminder confirmation route."""
    router = APIRouter(route_class=_ReminderStateRoute)
    bearer = HTTPBearer(auto_error=False)

    def trusted_account(
        _credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer),
        ],
        authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    ) -> AuthenticatedAccount:
        return authenticated_account(authorization)

    @router.put(
        "/api/v1/schedule/reminder-state",
        response_model=ReminderStateResponse,
        responses={
            401: {"model": ReminderStateErrorEnvelope},
            404: {"model": ReminderStateErrorEnvelope},
            409: {"model": ReminderStateErrorEnvelope},
            422: {"model": ReminderStateInvalidRequestResponse},
            500: {"model": ReminderStateErrorEnvelope},
        },
    )
    def confirm_reminder_state(
        request: ReminderStateRequest,
        account: Annotated[AuthenticatedAccount, Security(trusted_account)],
    ) -> Response:
        try:
            result = confirmer.confirm(
                account_id=account.account_id,
                schedule_id=request.schedule_id,
            )
            response = ReminderStateResponse(
                schedule_id=result.schedule_id,
                disposition_state=result.disposition_state,
                updated_at=_as_utc(result.updated_at),
            )
            return JSONResponse(status_code=200, content=response.model_dump(mode="json"))
        except ScheduleBusinessError as error:
            if error.code is ScheduleErrorCode.SCHEDULE_NOT_FOUND:
                return _error_response(404, "SCHEDULE_NOT_FOUND", "Schedule not found")
            if error.code is ScheduleErrorCode.REMINDER_NOT_CONFIGURED:
                return _error_response(
                    409,
                    "REMINDER_NOT_CONFIGURED",
                    "Reminder not configured",
                )
            return _internal_error_response(error)
        except Exception as error:
            return _internal_error_response(error)

    return router


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    envelope = ReminderStateErrorEnvelope(
        error=ReminderStateErrorDetail(code=code, message=message)
    )
    return JSONResponse(status_code=status_code, content=envelope.model_dump())


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _internal_error_response(error: Exception) -> JSONResponse:
    log_sanitized_exception(
        logger,
        error,
        event_prefix="reminder_state_event",
        error_code="REMINDER_STATE_INTERNAL_ERROR",
        status_code=500,
        message="reminder state service unavailable",
    )
    return _error_response(
        500,
        "REMINDER_STATE_INTERNAL_ERROR",
        "Reminder state service unavailable",
    )


__all__ = [
    "ReminderStateErrorDetail",
    "ReminderStateErrorEnvelope",
    "ReminderStateInvalidRequestResponse",
    "ReminderStateRequest",
    "ReminderStateResponse",
    "create_reminder_state_router",
]
