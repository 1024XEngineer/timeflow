"""账户访问与稳定认证错误的 HTTP 适配器。"""

import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import uuid4

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import Response

from timeflow.business.auth import AuthAccessResult, AuthError, AuthErrorCode

logger = logging.getLogger(__name__)


class AuthAccess(Protocol):
    """HTTP 适配器使用的账户访问用例。"""

    def access(self, username: str, password: str) -> AuthAccessResult: ...


class AuthAccessRequest(BaseModel):
    """仅定义传输结构；凭据规则仍由业务值对象负责。"""

    model_config = ConfigDict(strict=True)

    username: str
    password: str = Field(repr=False)


class AuthAccessResponse(BaseModel):
    """共享契约的成功响应结构。"""

    model_config = ConfigDict(frozen=True)

    account_id: str
    access_token: str = Field(repr=False)
    expires_in: int


class AuthErrorDetail(BaseModel):
    """HTTP 错误响应内的稳定错误字段。"""

    model_config = ConfigDict(frozen=True)

    code: str
    message: str


class AuthErrorEnvelope(BaseModel):
    """共享契约的 HTTP 错误响应结构。"""

    model_config = ConfigDict(frozen=True)

    error: AuthErrorDetail


@dataclass(frozen=True, slots=True)
class AuthHttpErrorSpec:
    """一项稳定的传输层错误映射。"""

    status_code: int
    code: str
    message: str


AUTH_REQUIRED = AuthHttpErrorSpec(401, "AUTH_REQUIRED", "Authentication required")
AUTH_INVALID_TOKEN = AuthHttpErrorSpec(401, "AUTH_INVALID_TOKEN", "Invalid access token")
AUTH_INTERNAL_ERROR = AuthHttpErrorSpec(
    500,
    "AUTH_INTERNAL_ERROR",
    "Authentication service unavailable",
)

_DOMAIN_ERROR_SPECS = {
    code: AuthHttpErrorSpec(status_code, code.value, code.message)
    for code, status_code in (
        (AuthErrorCode.INVALID_USERNAME, 400),
        (AuthErrorCode.INVALID_PASSWORD, 400),
        (AuthErrorCode.INVALID_CREDENTIALS, 401),
    )
}


class AuthHttpError(Exception):
    """可复用 HTTP 依赖抛出的认证错误。"""

    __slots__ = ("spec",)

    def __init__(self, spec: AuthHttpErrorSpec) -> None:
        super().__init__(spec.code)
        self.spec = spec


def _error_response(spec: AuthHttpErrorSpec) -> JSONResponse:
    envelope = AuthErrorEnvelope(error=AuthErrorDetail(code=spec.code, message=spec.message))
    return JSONResponse(status_code=spec.status_code, content=envelope.model_dump())


def _new_internal_error() -> AuthHttpError:
    event_id = f"auth_event_{uuid4().hex}"
    logger.error(
        "authentication service unavailable",
        extra={
            "event_id": event_id,
            "error_code": AUTH_INTERNAL_ERROR.code,
            "status_code": AUTH_INTERNAL_ERROR.status_code,
        },
    )
    return AuthHttpError(AUTH_INTERNAL_ERROR)


def _service_error_response(error: Exception) -> JSONResponse:
    if isinstance(error, AuthError):
        spec = _DOMAIN_ERROR_SPECS.get(error.code)
        if spec is not None:
            return _error_response(spec)
    return _error_response(_new_internal_error().spec)


def _single_invalid_request_field(error: RequestValidationError) -> AuthErrorCode | None:
    """仅映射契约已明确的单字段错误；其余请求体错误交由 FastAPI。"""
    fields: set[str] = set()
    for detail in error.errors():
        location = detail.get("loc", ())
        if (
            len(location) < 2
            or location[0] != "body"
            or location[1] not in {"username", "password"}
        ):
            return None
        fields.add(str(location[1]))

    if fields == {"username"}:
        return AuthErrorCode.INVALID_USERNAME
    if fields == {"password"}:
        return AuthErrorCode.INVALID_PASSWORD
    return None


def _uncontracted_validation_response() -> JSONResponse:
    """在契约补齐前返回不包含请求输入的临时校验错误。"""
    return JSONResponse(status_code=422, content={"detail": "Invalid request body"})


class _AuthAccessRoute(APIRoute):
    """仅将契约定义的请求校验失败从 422 转为 400。"""

    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original_handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            try:
                return await original_handler(request)
            except RequestValidationError as error:
                error_code = _single_invalid_request_field(error)
                if error_code is None:
                    return _uncontracted_validation_response()
                return _error_response(_DOMAIN_ERROR_SPECS[error_code])

        return route_handler


def create_auth_router(auth_access: AuthAccess) -> APIRouter:
    """用注入的账户访问用例构建公开路由。"""
    router = APIRouter(route_class=_AuthAccessRoute)

    @router.post(
        "/api/v1/auth/access",
        response_model=AuthAccessResponse,
        responses={400: {"model": AuthErrorEnvelope}, 401: {"model": AuthErrorEnvelope}},
    )
    def access(request: AuthAccessRequest) -> AuthAccessResponse | Response:
        try:
            result = auth_access.access(request.username, request.password)
        except Exception as error:
            return _service_error_response(error)
        return AuthAccessResponse(
            account_id=result.account_id,
            access_token=result.access_token,
            expires_in=result.expires_in,
        )

    return router


async def auth_http_error_handler(_request: Request, error: Exception) -> Response:
    """渲染可复用认证依赖抛出的错误。"""
    if not isinstance(error, AuthHttpError):
        raise error
    return _error_response(error.spec)


def install_auth_http_error_handler(application: FastAPI) -> None:
    """安装认证 HTTP 依赖所需的错误处理器。"""
    application.add_exception_handler(AuthHttpError, auth_http_error_handler)


__all__ = [
    "AuthAccess",
    "AuthAccessRequest",
    "AuthAccessResponse",
    "AuthErrorDetail",
    "AuthErrorEnvelope",
    "AuthHttpError",
    "AuthHttpErrorSpec",
    "auth_http_error_handler",
    "create_auth_router",
    "install_auth_http_error_handler",
]
