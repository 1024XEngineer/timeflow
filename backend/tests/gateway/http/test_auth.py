"""HTTP 账户访问契约测试。"""

import logging
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from timeflow.business.auth import AuthAccessResult, AuthError, AuthErrorCode
from timeflow.gateway.http import create_auth_router


@dataclass
class _AccessStub:
    result: AuthAccessResult | None = None
    error: Exception | None = None

    def __post_init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def access(self, username: str, password: str) -> AuthAccessResult:
        self.calls.append((username, password))
        if self.error is not None:
            raise self.error
        assert self.result is not None
        return self.result


def _client(service: _AccessStub) -> TestClient:
    application = FastAPI()
    application.include_router(create_auth_router(service))
    return TestClient(application, raise_server_exceptions=False)


def _error(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def test_access_returns_the_exact_success_contract_without_consuming_authorization() -> None:
    service = _AccessStub(AuthAccessResult("acc_001", "access-token", 3600))

    response = _client(service).post(
        "/api/v1/auth/access",
        json={"username": "  Alice  ", "password": "strong-password"},
        headers={"Authorization": "not-a-bearer-header"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {
        "account_id": "acc_001",
        "access_token": "access-token",
        "expires_in": 3600,
    }
    assert service.calls == [("  Alice  ", "strong-password")]


@pytest.mark.parametrize(
    ("code", "status_code", "message"),
    [
        (AuthErrorCode.INVALID_USERNAME, 400, "Invalid username"),
        (AuthErrorCode.INVALID_PASSWORD, 400, "Invalid password"),
        (AuthErrorCode.INVALID_CREDENTIALS, 401, "Invalid username or password"),
    ],
)
def test_access_maps_each_defined_domain_error(
    code: AuthErrorCode,
    status_code: int,
    message: str,
) -> None:
    service = _AccessStub(error=AuthError(code))

    response = _client(service).post(
        "/api/v1/auth/access",
        json={"username": "Alice", "password": "strong-password"},
    )

    assert response.status_code == status_code
    assert response.headers["content-type"] == "application/json"
    assert response.json() == _error(code.value, message)


@pytest.mark.parametrize(
    ("body", "code", "message"),
    [
        ({"password": "strong-password"}, "AUTH_INVALID_USERNAME", "Invalid username"),
        (
            {"username": 123, "password": "strong-password"},
            "AUTH_INVALID_USERNAME",
            "Invalid username",
        ),
        ({"username": "Alice"}, "AUTH_INVALID_PASSWORD", "Invalid password"),
        (
            {"username": "Alice", "password": 123},
            "AUTH_INVALID_PASSWORD",
            "Invalid password",
        ),
    ],
)
def test_access_maps_a_missing_or_wrongly_typed_single_field_to_400(
    body: dict[str, object],
    code: str,
    message: str,
) -> None:
    service = _AccessStub(AuthAccessResult("unused", "unused", 3600))

    response = _client(service).post("/api/v1/auth/access", json=body)

    assert response.status_code == 400
    assert response.json() == _error(code, message)
    assert service.calls == []


def test_access_logs_only_an_internal_event_for_unknown_failures(
    caplog: pytest.LogCaptureFixture,
) -> None:
    password = "never-log-this-password"
    internal_detail = "database-exception-containing-sensitive-data"
    service = _AccessStub(error=RuntimeError(internal_detail))

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.auth"):
        response = _client(service).post(
            "/api/v1/auth/access",
            json={"username": "sensitive-user", "password": password},
        )

    assert response.status_code == 500
    assert response.json() == _error("AUTH_INTERNAL_ERROR", "Authentication service unavailable")
    assert password not in response.text
    assert password not in caplog.text
    assert internal_detail not in response.text
    assert internal_detail not in caplog.text
    assert "sensitive-user" not in caplog.text
    record = caplog.records[-1]
    assert record.event_id.startswith("auth_event_")
    assert record.error_code == "AUTH_INTERNAL_ERROR"
    assert record.status_code == 500


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        ('{"username":"Alice","password":"never-return-this-password"', "application/json"),
        ("username=Alice&password=never-return-this-password", "application/x-www-form-urlencoded"),
    ],
)
def test_uncontracted_body_errors_do_not_echo_sensitive_input(
    body: str,
    content_type: str,
) -> None:
    """未冻结错误码的请求体错误也不能回显敏感输入。"""
    service = _AccessStub(AuthAccessResult("unused", "unused", 3600))

    response = _client(service).post(
        "/api/v1/auth/access",
        content=body,
        headers={"Content-Type": content_type},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request body"}
    assert "never-return-this-password" not in response.text
    assert service.calls == []
