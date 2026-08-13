"""HTTP 可信认证上下文测试。"""

import logging
from dataclasses import FrozenInstanceError
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from timeflow.business.auth import IssuedAccessTokenView
from timeflow.gateway.http import (
    AuthenticatedAccount,
    create_authenticated_account_dependency,
    install_auth_http_error_handler,
)


class _Tokens:
    def __init__(
        self,
        account_id: str | None = None,
        error: Exception | None = None,
    ) -> None:
        self.account_id = account_id
        self.error = error
        self.verified: list[str] = []

    def issue(self, account_id: str) -> IssuedAccessTokenView:
        raise AssertionError(f"dependency must not issue a token for {account_id}")

    def verify(self, token: str) -> str | None:
        self.verified.append(token)
        if self.error is not None:
            raise self.error
        return self.account_id


def _client(tokens: _Tokens) -> TestClient:
    application = FastAPI()
    install_auth_http_error_handler(application)
    dependency = create_authenticated_account_dependency(tokens)

    @application.get("/protected")
    def protected(
        account: Annotated[AuthenticatedAccount, Depends(dependency)],
        account_id: str | None = None,
    ) -> dict[str, str | None]:
        return {"trusted_account_id": account.account_id, "supplied_account_id": account_id}

    return TestClient(application, raise_server_exceptions=False)


def _error(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def test_missing_bearer_token_requires_authentication_without_calling_verifier() -> None:
    tokens = _Tokens("acc_verified")

    response = _client(tokens).get("/protected")

    assert response.status_code == 401
    assert response.json() == _error("AUTH_REQUIRED", "Authentication required")
    assert tokens.verified == []


def test_invalid_bearer_token_is_rejected() -> None:
    tokens = _Tokens(None)

    response = _client(tokens).get("/protected", headers={"Authorization": "Bearer invalid-token"})

    assert response.status_code == 401
    assert response.json() == _error("AUTH_INVALID_TOKEN", "Invalid access token")
    assert tokens.verified == ["invalid-token"]


def test_non_string_verified_identity_is_rejected() -> None:
    """违反端口约定的验证结果不能进入可信账户上下文。"""
    tokens = _Tokens()
    tokens.account_id = 123  # type: ignore[assignment]

    response = _client(tokens).get(
        "/protected",
        headers={"Authorization": "Bearer invalid-subject"},
    )

    assert response.status_code == 401
    assert response.json() == _error("AUTH_INVALID_TOKEN", "Invalid access token")


def test_valid_bearer_token_returns_an_immutable_trusted_account() -> None:
    tokens = _Tokens("acc_verified")

    response = _client(tokens).get(
        "/protected?account_id=acc_attacker",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "trusted_account_id": "acc_verified",
        "supplied_account_id": "acc_attacker",
    }
    assert tokens.verified == ["valid-token"]
    account = AuthenticatedAccount("acc_verified")
    with pytest.raises(FrozenInstanceError):
        account.account_id = "acc_changed"  # type: ignore[misc]


def test_verifier_failure_returns_a_sanitized_internal_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    internal_detail = "token-provider-sensitive-detail"
    tokens = _Tokens(error=RuntimeError(internal_detail))

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.auth"):
        response = _client(tokens).get(
            "/protected",
            headers={"Authorization": "Bearer never-log-this-token"},
        )

    assert response.status_code == 500
    assert response.json() == _error("AUTH_INTERNAL_ERROR", "Authentication service unavailable")
    assert "never-log-this-token" not in caplog.text
    assert internal_detail not in caplog.text
    record = caplog.records[-1]
    assert record.event_id.startswith("auth_event_")
    response_event_id = response.headers.get("x-auth-event-id")
    assert response_event_id == record.event_id
    assert response_event_id is not None
    assert record.exception_module == "builtins"
    assert record.exception_type == "RuntimeError"
    assert record.traceback_frames
    assert all(
        set(frame) == {"filename", "lineno", "function"} for frame in record.traceback_frames
    )
