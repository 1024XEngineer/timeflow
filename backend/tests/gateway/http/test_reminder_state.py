"""HTTP contract tests for final reminder confirmation sync."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from timeflow.business.calendar import (
    ReminderDispositionResult,
    ReminderDispositionState,
    ScheduleBusinessError,
    ScheduleErrorCode,
)
from timeflow.gateway.http import (
    create_authenticated_account_dependency,
    install_auth_http_error_handler,
)
from timeflow.gateway.http.reminder_state import create_reminder_state_router

UPDATED_AT = datetime(2026, 8, 17, 3, 30, tzinfo=UTC)
VALID_BODY = {
    "schedule_id": "schedule-001",
    "disposition_state": "confirmed",
}
AUTHORIZATION = {"Authorization": "Bearer valid-token"}


class _Tokens:
    def verify(self, token: str) -> str | None:
        if token == "valid-token":
            return "account-a"
        return None


@dataclass
class _Confirmer:
    result: ReminderDispositionResult = ReminderDispositionResult(
        schedule_id="schedule-001",
        disposition_state=ReminderDispositionState.CONFIRMED,
        updated_at=UPDATED_AT,
    )
    error: Exception | None = None
    calls: list[tuple[str, str]] = field(default_factory=list)

    def confirm(self, *, account_id: str, schedule_id: str) -> ReminderDispositionResult:
        self.calls.append((account_id, schedule_id))
        if self.error is not None:
            raise self.error
        return self.result


def _client(confirmer: _Confirmer) -> TestClient:
    application = FastAPI()
    install_auth_http_error_handler(application)
    dependency = create_authenticated_account_dependency(_Tokens())  # type: ignore[arg-type]
    application.include_router(create_reminder_state_router(confirmer, dependency))
    return TestClient(application, raise_server_exceptions=False)


def _error(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def test_confirmation_uses_authenticated_account_and_returns_final_state() -> None:
    confirmer = _Confirmer()

    response = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        headers=AUTHORIZATION,
        json=VALID_BODY,
    )

    assert response.status_code == 200
    assert response.json() == {
        "schedule_id": "schedule-001",
        "disposition_state": "confirmed",
        "updated_at": "2026-08-17T03:30:00Z",
    }
    assert confirmer.calls == [("account-a", "schedule-001")]


def test_naive_persistence_timestamp_is_returned_as_utc() -> None:
    confirmer = _Confirmer()
    confirmer.result = replace(confirmer.result, updated_at=UPDATED_AT.replace(tzinfo=None))

    response = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        headers=AUTHORIZATION,
        json=VALID_BODY,
    )

    assert response.status_code == 200
    assert response.json()["updated_at"] == "2026-08-17T03:30:00Z"


def test_missing_or_invalid_token_never_calls_business_service() -> None:
    confirmer = _Confirmer()

    missing = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        json=VALID_BODY,
    )
    invalid = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        headers={"Authorization": "Bearer invalid-token"},
        json=VALID_BODY,
    )

    assert missing.status_code == 401
    assert missing.json() == _error("AUTH_REQUIRED", "Authentication required")
    assert invalid.status_code == 401
    assert invalid.json() == _error("AUTH_INVALID_TOKEN", "Invalid access token")
    assert confirmer.calls == []


@pytest.mark.parametrize(
    "body",
    [
        {"disposition_state": "confirmed"},
        {"schedule_id": "", "disposition_state": "confirmed"},
        {"schedule_id": "   ", "disposition_state": "confirmed"},
        {"schedule_id": "schedule-001", "disposition_state": "dismissed"},
        {"schedule_id": "schedule-001", "disposition_state": True},
        {**VALID_BODY, "account_id": "account-b"},
        {**VALID_BODY, "updated_at": "2026-08-17T03:30:00Z"},
        {**VALID_BODY, "sync_status": "success"},
        {**VALID_BODY, "occurrence_id": "occurrence-001"},
    ],
)
def test_invalid_or_extra_request_fields_return_stable_422_without_service_call(
    body: dict[str, object],
) -> None:
    confirmer = _Confirmer()

    response = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        headers=AUTHORIZATION,
        json=body,
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request body"}
    assert confirmer.calls == []


@pytest.mark.parametrize(
    ("code", "status_code", "response_code", "message"),
    [
        (
            ScheduleErrorCode.SCHEDULE_NOT_FOUND,
            404,
            "SCHEDULE_NOT_FOUND",
            "Schedule not found",
        ),
        (
            ScheduleErrorCode.REMINDER_NOT_CONFIGURED,
            409,
            "REMINDER_NOT_CONFIGURED",
            "Reminder not configured",
        ),
    ],
)
def test_expected_business_failures_have_stable_http_mappings(
    code: ScheduleErrorCode,
    status_code: int,
    response_code: str,
    message: str,
) -> None:
    confirmer = _Confirmer(
        error=ScheduleBusinessError(
            code=code,
            message="business detail must not define the HTTP contract",
            schedule_id="schedule-001",
        )
    )

    response = _client(confirmer).put(
        "/api/v1/schedule/reminder-state",
        headers=AUTHORIZATION,
        json=VALID_BODY,
    )

    assert response.status_code == status_code
    assert response.json() == _error(response_code, message)


def test_unexpected_failure_is_sanitized_and_returns_stable_500(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sensitive_detail = "database-dsn-and-secret"
    confirmer = _Confirmer(error=RuntimeError(sensitive_detail))

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.reminder_state"):
        response = _client(confirmer).put(
            "/api/v1/schedule/reminder-state",
            headers=AUTHORIZATION,
            json=VALID_BODY,
        )

    assert response.status_code == 500
    assert response.json() == _error(
        "REMINDER_STATE_INTERNAL_ERROR",
        "Reminder state service unavailable",
    )
    assert sensitive_detail not in caplog.text
    assert "valid-token" not in caplog.text
    assert caplog.records[-1].event_id.startswith("reminder_state_event_")


def test_malformed_service_result_also_returns_stable_500(
    caplog: pytest.LogCaptureFixture,
) -> None:
    confirmer = _Confirmer()
    confirmer.result = replace(confirmer.result, updated_at=cast(Any, object()))

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.reminder_state"):
        response = _client(confirmer).put(
            "/api/v1/schedule/reminder-state",
            headers=AUTHORIZATION,
            json=VALID_BODY,
        )

    assert response.status_code == 500
    assert response.json() == _error(
        "REMINDER_STATE_INTERNAL_ERROR",
        "Reminder state service unavailable",
    )
    assert caplog.records[-1].event_id.startswith("reminder_state_event_")


def test_openapi_declares_bearer_auth_and_exact_request_fields() -> None:
    schema = _client(_Confirmer()).get("/openapi.json").json()
    operation = schema["paths"]["/api/v1/schedule/reminder-state"]["put"]
    request_schema = operation["requestBody"]["content"]["application/json"]["schema"]
    model_name = request_schema["$ref"].rsplit("/", 1)[-1]
    model = schema["components"]["schemas"][model_name]

    assert operation["security"] == [{"HTTPBearer": []}]
    assert set(model["properties"]) == {"schedule_id", "disposition_state"}
    assert model["additionalProperties"] is False
    response_schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
    response_name = response_schema["$ref"].rsplit("/", 1)[-1]
    response_model = schema["components"]["schemas"][response_name]
    assert response_model["properties"]["updated_at"]["format"] == "date-time"
    validation_schema = operation["responses"]["422"]["content"]["application/json"]["schema"]
    validation_name = validation_schema["$ref"].rsplit("/", 1)[-1]
    validation_model = schema["components"]["schemas"][validation_name]
    assert validation_model["properties"]["detail"]["const"] == "Invalid request body"
