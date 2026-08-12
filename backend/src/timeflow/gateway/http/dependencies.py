"""受保护 HTTP 路由可复用的账户认证依赖。"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Header

from timeflow.business.auth import AccessTokenService
from timeflow.gateway.http.auth import (
    AUTH_INVALID_TOKEN,
    AUTH_REQUIRED,
    AuthHttpError,
    _new_internal_error,
)

_BEARER_PATTERN = re.compile(r"Bearer ([^\s]+)")

# v1 尚未固定畸形 Authorization 语法的处理方式。集中在此处赋值，
# 使策略明确，并便于随契约调整。
_MALFORMED_BEARER_ERROR = AUTH_INVALID_TOKEN


@dataclass(frozen=True, slots=True)
class AuthenticatedAccount:
    """仅由已验证访问令牌派生的可信身份。"""

    account_id: str


AuthenticatedAccountDependency = Callable[[str | None], AuthenticatedAccount]


def _extract_bearer_token(authorization: str) -> str | None:
    match = _BEARER_PATTERN.fullmatch(authorization)
    return match.group(1) if match is not None else None


def create_authenticated_account_dependency(
    access_token_service: AccessTokenService,
) -> AuthenticatedAccountDependency:
    """基于共享令牌服务构建同步依赖。"""

    def authenticated_account(
        authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    ) -> AuthenticatedAccount:
        if authorization is None:
            raise AuthHttpError(AUTH_REQUIRED)

        token = _extract_bearer_token(authorization)
        if token is None:
            raise AuthHttpError(_MALFORMED_BEARER_ERROR)

        try:
            account_id = access_token_service.verify(token)
        except Exception:
            raise _new_internal_error() from None
        if not isinstance(account_id, str) or not account_id:
            raise AuthHttpError(AUTH_INVALID_TOKEN)
        return AuthenticatedAccount(account_id=account_id)

    return authenticated_account


__all__ = [
    "AuthenticatedAccount",
    "AuthenticatedAccountDependency",
    "create_authenticated_account_dependency",
]
