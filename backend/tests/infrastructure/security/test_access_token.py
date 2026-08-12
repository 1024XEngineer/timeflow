"""严格的 v1 访问令牌服务测试。"""

from datetime import UTC, datetime
from typing import Any

import jwt
import pytest
from auth_test_support import (
    OTHER_TEST_JWT_SECRET,
    TEST_JWT_SECRET,
    encode_test_token,
)

from timeflow.infrastructure.security.access_token import (
    JWT_ACCESS_TTL_SECONDS,
    JWT_ALGORITHM,
    JWT_AUDIENCE,
    JWT_ISSUER,
    IssuedAccessToken,
    JwtAccessTokenService,
)

ACCOUNT_ID = "acc_0123456789abcdef"


def build_service(**overrides: Any) -> JwtAccessTokenService:
    arguments: dict[str, Any] = {
        "secret": TEST_JWT_SECRET,
        "issuer": JWT_ISSUER,
        "audience": JWT_AUDIENCE,
        "access_ttl_seconds": JWT_ACCESS_TTL_SECONDS,
    }
    arguments.update(overrides)
    return JwtAccessTokenService(**arguments)


def encode_token(**overrides: Any) -> str:
    return encode_test_token(account_id=ACCOUNT_ID, claims=overrides)


def test_issue_returns_immutable_hidden_token_with_exact_v1_claims() -> None:
    service = build_service()

    issued = service.issue(ACCOUNT_ID)
    header = jwt.get_unverified_header(issued.access_token)
    payload = jwt.decode(
        issued.access_token,
        TEST_JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=JWT_AUDIENCE,
        issuer=JWT_ISSUER,
    )

    assert isinstance(issued, IssuedAccessToken)
    assert issued.expires_in == JWT_ACCESS_TTL_SECONDS
    assert header["alg"] == JWT_ALGORITHM
    assert payload["sub"] == ACCOUNT_ID
    assert payload["iss"] == JWT_ISSUER
    assert payload["aud"] == JWT_AUDIENCE
    assert payload["exp"] - payload["iat"] == JWT_ACCESS_TTL_SECONDS
    assert set(payload) == {"sub", "iat", "exp", "iss", "aud"}
    assert issued.access_token not in repr(issued)


def test_issue_and_verify_round_trip() -> None:
    service = build_service()

    issued = service.issue(ACCOUNT_ID)

    assert service.verify(issued.access_token) == ACCOUNT_ID


@pytest.mark.parametrize("account_id", ["", None, 123])
def test_issue_rejects_invalid_subject(account_id: object) -> None:
    with pytest.raises(ValueError, match="account_id must be a non-empty string"):
        build_service().issue(account_id)  # type: ignore[arg-type]


def test_issue_rejects_a_naive_clock() -> None:
    service = build_service(clock=lambda: datetime(2026, 8, 12))

    with pytest.raises(ValueError, match="clock must return a timezone-aware datetime"):
        service.issue(ACCOUNT_ID)


@pytest.mark.parametrize("secret", ["", "x" * 31, "\ud800" * 32])
def test_service_rejects_empty_or_weak_secret_without_revealing_it(secret: str) -> None:
    with pytest.raises(ValueError, match="JWT secret must be at least 32 UTF-8 bytes") as error:
        build_service(secret=secret)

    assert secret not in str(error.value) or secret == ""


def test_service_measures_secret_in_utf8_bytes() -> None:
    service = build_service(secret="密" * 11)

    assert service.verify(service.issue(ACCOUNT_ID).access_token) == ACCOUNT_ID


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"issuer": ""}, "JWT issuer must match the v1 contract"),
        ({"issuer": "other-api"}, "JWT issuer must match the v1 contract"),
        ({"audience": ""}, "JWT audience must match the v1 contract"),
        ({"audience": "other-app"}, "JWT audience must match the v1 contract"),
        ({"access_ttl_seconds": 0}, "JWT access TTL must match the v1 contract"),
        ({"access_ttl_seconds": 7200}, "JWT access TTL must match the v1 contract"),
    ],
)
def test_service_rejects_non_v1_configuration(
    overrides: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        build_service(**overrides)


@pytest.mark.parametrize("missing_claim", ["sub", "iat", "exp", "iss", "aud"])
def test_verify_rejects_each_missing_required_claim(missing_claim: str) -> None:
    token = encode_test_token(account_id=ACCOUNT_ID, omitted_claims=(missing_claim,))

    assert build_service().verify(token) is None


@pytest.mark.parametrize(
    "token",
    [
        "not-a-jwt",
        encode_test_token(account_id=ACCOUNT_ID, issued_at=1),
        encode_test_token(account_id=ACCOUNT_ID, secret=OTHER_TEST_JWT_SECRET),
        encode_test_token(account_id=ACCOUNT_ID, algorithm="HS384"),
        encode_token(iss="other-api"),
        encode_token(aud="other-app"),
        encode_token(aud=[JWT_AUDIENCE, "other-app"]),
        encode_token(iat=int(datetime.now(UTC).timestamp()) + 60),
        encode_token(exp=int(datetime.now(UTC).timestamp()) + 7200),
        encode_token(sub=""),
        encode_token(sub=123),
        encode_token(iat="not-a-number"),
        encode_token(exp="not-a-number"),
    ],
)
def test_verify_rejects_invalid_tokens(token: str) -> None:
    assert build_service().verify(token) is None


@pytest.mark.parametrize("token", ["", None, 123])
def test_verify_rejects_non_token_values(token: object) -> None:
    assert build_service().verify(token) is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("claim", "value"),
    [
        ("iat", {}),
        ("iat", []),
        ("exp", {}),
        ("exp", []),
    ],
)
def test_verify_rejects_container_numeric_dates(claim: str, value: object) -> None:
    token = encode_token(**{claim: value})

    assert build_service().verify(token) is None


@pytest.mark.parametrize("value", [float("inf"), float("-inf")])
def test_verify_rejects_infinite_numeric_dates(value: float) -> None:
    assert build_service().verify(encode_token(iat=value)) is None


def test_verify_rejects_token_with_invalid_unicode() -> None:
    assert build_service().verify("\ud800") is None
