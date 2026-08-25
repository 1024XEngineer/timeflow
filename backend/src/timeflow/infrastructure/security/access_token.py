"""严格签发并验证 HS256 访问令牌。"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, cast

import jwt

JWT_ALGORITHM: Final = "HS256"
JWT_ISSUER: Final = "timeflow-api"
JWT_AUDIENCE: Final = "timeflow-app"
JWT_ACCESS_TTL_SECONDS: Final = 30 * 24 * 60 * 60  # 默认一个月（30 天）
MINIMUM_SECRET_BYTES: Final = 32
REQUIRED_CLAIMS: Final = ("sub", "iat", "exp", "iss", "aud")


@dataclass(frozen=True, slots=True)
class IssuedAccessToken:
    """不在对象表示中泄露凭据的不可变令牌视图。"""

    _access_token: str = field(repr=False)
    _expires_in: int = field(repr=False)

    @property
    def access_token(self) -> str:
        """返回编码后的访问令牌。"""
        return self._access_token

    @property
    def expires_in(self) -> int:
        """返回令牌有效期，单位为秒。"""
        return self._expires_in


class JwtAccessTokenService:
    """签发并验证唯一的 v1 访问令牌格式。"""

    def __init__(
        self,
        *,
        secret: str,
        issuer: str,
        audience: str,
        access_ttl_seconds: int,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._validate_configuration(secret, issuer, audience, access_ttl_seconds)
        self._secret = secret
        self._issuer = issuer
        self._audience = audience
        self._access_ttl_seconds = access_ttl_seconds
        self._clock = clock or (lambda: datetime.now(UTC))

    def issue(self, account_id: str) -> IssuedAccessToken:
        """为服务端生成的非空账户 ID 签发 v1 令牌。"""
        if not isinstance(account_id, str) or not account_id:
            raise ValueError("account_id must be a non-empty string")

        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("clock must return a timezone-aware datetime")
        issued_at = int(now.timestamp())
        expires_at = issued_at + self._access_ttl_seconds
        access_token = jwt.encode(
            {
                "sub": account_id,
                "iat": issued_at,
                "exp": expires_at,
                "iss": self._issuer,
                "aud": self._audience,
            },
            self._secret,
            algorithm=JWT_ALGORITHM,
        )
        return IssuedAccessToken(access_token, self._access_ttl_seconds)

    def verify(self, token: str) -> str | None:
        """有效则返回 v1 令牌主体，否则拒绝验证。"""
        if not isinstance(token, str) or not token:
            return None

        try:
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=[JWT_ALGORITHM],
                audience=self._audience,
                issuer=self._issuer,
                options={
                    "require": list(REQUIRED_CLAIMS),
                    "verify_aud": True,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_iss": True,
                },
            )
        except (jwt.PyJWTError, OverflowError, TypeError, UnicodeError, ValueError):
            return None

        subject = payload.get("sub")
        issued_at = payload.get("iat")
        expires_at = payload.get("exp")
        if not isinstance(subject, str) or not subject:
            return None
        if payload.get("iss") != self._issuer or payload.get("aud") != self._audience:
            return None
        if not _is_numeric_date(issued_at) or not _is_numeric_date(expires_at):
            return None
        if cast(int, expires_at) - cast(int, issued_at) != self._access_ttl_seconds:
            return None
        return subject

    @staticmethod
    def _validate_configuration(
        secret: str,
        issuer: str,
        audience: str,
        access_ttl_seconds: int,
    ) -> None:
        try:
            secret_is_strong = (
                isinstance(secret, str) and len(secret.encode("utf-8")) >= MINIMUM_SECRET_BYTES
            )
        except UnicodeError:
            secret_is_strong = False
        if not secret_is_strong:
            raise ValueError("JWT secret must be at least 32 UTF-8 bytes")
        if issuer != JWT_ISSUER:
            raise ValueError("JWT issuer must match the v1 contract")
        if audience != JWT_AUDIENCE:
            raise ValueError("JWT audience must match the v1 contract")
        if access_ttl_seconds <= 0:
            raise ValueError("JWT access TTL must be greater than zero")


def _is_numeric_date(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
