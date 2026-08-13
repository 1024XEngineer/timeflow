"""认证测试共用的确定性 JWT 配置与工厂。"""

from collections.abc import Callable, Collection, Mapping
from datetime import UTC, datetime
from typing import Any

import jwt

from timeflow.infrastructure.security import JwtAccessTokenService
from timeflow.infrastructure.security.access_token import (
    JWT_ACCESS_TTL_SECONDS,
    JWT_ALGORITHM,
    JWT_AUDIENCE,
    JWT_ISSUER,
)

TEST_JWT_SECRET = "test-only-jwt-secret-with-at-least-forty-eight-bytes"
OTHER_TEST_JWT_SECRET = "other-test-jwt-secret-with-at-least-forty-eight-bytes"
TEST_JWT_ENVIRONMENT = {
    "TIMEFLOW_JWT_SECRET": TEST_JWT_SECRET,
    "TIMEFLOW_JWT_ISSUER": JWT_ISSUER,
    "TIMEFLOW_JWT_AUDIENCE": JWT_AUDIENCE,
    "TIMEFLOW_JWT_ACCESS_TTL_SECONDS": str(JWT_ACCESS_TTL_SECONDS),
}


def build_test_token_service(
    *,
    clock: Callable[[], datetime] | None = None,
) -> JwtAccessTokenService:
    """使用共享契约的固定测试值构建真实 JWT 服务。"""
    return JwtAccessTokenService(
        secret=TEST_JWT_SECRET,
        issuer=JWT_ISSUER,
        audience=JWT_AUDIENCE,
        access_ttl_seconds=JWT_ACCESS_TTL_SECONDS,
        clock=clock,
    )


def encode_test_token(
    *,
    account_id: object = "acc_test",
    secret: str = TEST_JWT_SECRET,
    algorithm: str = JWT_ALGORITHM,
    issued_at: int | None = None,
    claims: Mapping[str, object] | None = None,
    omitted_claims: Collection[str] = (),
) -> str:
    """从一套共享 v1 声明生成可按需破坏的测试令牌。"""
    issued_at = issued_at if issued_at is not None else int(datetime.now(UTC).timestamp())
    payload: dict[str, Any] = {
        "sub": account_id,
        "iat": issued_at,
        "exp": issued_at + JWT_ACCESS_TTL_SECONDS,
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
    }
    if claims is not None:
        payload.update(claims)
    for claim in omitted_claims:
        payload.pop(claim, None)
    return jwt.encode(payload, secret, algorithm=algorithm)
