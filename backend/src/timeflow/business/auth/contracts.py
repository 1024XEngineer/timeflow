"""与框架无关的账户认证契约。"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from types import TracebackType
from typing import Protocol, Self


class AuthErrorCode(StrEnum):
    """供入站适配器共用的稳定认证错误码。"""

    INVALID_USERNAME = "AUTH_INVALID_USERNAME"
    INVALID_PASSWORD = "AUTH_INVALID_PASSWORD"
    INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS"

    @property
    def message(self) -> str:
        """返回共享契约为该错误码固定的公开消息。"""
        return _AUTH_ERROR_MESSAGES[self]


_AUTH_ERROR_MESSAGES = {
    AuthErrorCode.INVALID_USERNAME: "Invalid username",
    AuthErrorCode.INVALID_PASSWORD: "Invalid password",
    AuthErrorCode.INVALID_CREDENTIALS: "Invalid username or password",
}


class AuthError(Exception):
    """可按错误码安全映射的预期认证异常。"""

    __slots__ = ("code",)

    def __init__(self, code: AuthErrorCode) -> None:
        super().__init__(code.message)
        self.code = code

    @property
    def message(self) -> str:
        """保留异常调用方使用的稳定消息视图。"""
        return self.code.message


@dataclass(frozen=True, slots=True)
class AuthCredentials:
    """规范化凭据，且密码不会出现在对象表示中。"""

    username: str
    password: str = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.username, str):
            raise AuthError(AuthErrorCode.INVALID_USERNAME)
        username = self.username.strip()
        if not 3 <= len(username) <= 64:
            raise AuthError(AuthErrorCode.INVALID_USERNAME)
        if not isinstance(self.password, str):
            raise AuthError(AuthErrorCode.INVALID_PASSWORD)
        if not 8 <= len(self.password) <= 128 or self.password.isspace():
            raise AuthError(AuthErrorCode.INVALID_PASSWORD)
        object.__setattr__(self, "username", username)


@dataclass(frozen=True, slots=True)
class AccountRecord:
    """密码验证所需且与持久化无关的账户数据。"""

    id: str
    username: str
    password_hash: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class NewAccount:
    """新增账户所需且与持久化无关的字段。"""

    id: str
    username: str
    password_hash: str = field(repr=False)
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AuthAccessResult:
    """返回给入站适配器的账户访问成功结果。"""

    account_id: str
    access_token: str = field(repr=False)
    expires_in: int


class UsernameConflictError(RuntimeError):
    """其他事务已占用请求的用户名。"""


class AccountRepositoryPort(Protocol):
    """认证所需的账户持久化操作。"""

    def get_by_username(self, username: str) -> AccountRecord | None: ...

    def add(self, account: NewAccount) -> AccountRecord: ...


class AuthUnitOfWork(Protocol):
    """单个隔离的认证事务。"""

    @property
    def accounts(self) -> AccountRepositoryPort: ...

    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


AuthUnitOfWorkFactory = Callable[[], AuthUnitOfWork]


class PasswordHasher(Protocol):
    """隐藏具体算法的密码哈希与验证接口。"""

    def hash(self, password: str) -> str: ...

    def verify(self, password: str, password_hash: str) -> bool: ...


class IssuedAccessTokenView(Protocol):
    """新签发访问令牌的只读视图。"""

    @property
    def access_token(self) -> str: ...

    @property
    def expires_in(self) -> int: ...


class AccessTokenService(Protocol):
    """通过同一安全适配器签发并验证访问令牌。"""

    def issue(self, account_id: str) -> IssuedAccessTokenView: ...

    def verify(self, token: str) -> str | None: ...


__all__ = [
    "AccessTokenService",
    "AccountRecord",
    "AccountRepositoryPort",
    "AuthAccessResult",
    "AuthCredentials",
    "AuthError",
    "AuthErrorCode",
    "AuthUnitOfWork",
    "AuthUnitOfWorkFactory",
    "IssuedAccessTokenView",
    "NewAccount",
    "PasswordHasher",
    "UsernameConflictError",
]
