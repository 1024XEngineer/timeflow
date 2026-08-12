"""凭据值对象与稳定认证错误测试。"""

from dataclasses import FrozenInstanceError

import pytest

from timeflow.business.auth import AuthCredentials, AuthError, AuthErrorCode


def test_credentials_normalize_only_username_and_hide_password() -> None:
    credentials = AuthCredentials("  Alice  ", "  password  ")

    assert credentials.username == "Alice"
    assert credentials.password == "  password  "
    assert "password" not in repr(credentials)
    with pytest.raises(FrozenInstanceError):
        credentials.username = "changed"  # type: ignore[misc]


@pytest.mark.parametrize("username", ["ab", "x" * 65, "   ", None])
def test_credentials_reject_invalid_username_with_stable_error(username: object) -> None:
    with pytest.raises(AuthError) as raised:
        AuthCredentials(username, "password")  # type: ignore[arg-type]

    assert raised.value.code is AuthErrorCode.INVALID_USERNAME
    assert raised.value.message == "Invalid username"
    assert str(raised.value) == "Invalid username"


@pytest.mark.parametrize("password", ["short7", "x" * 129, " " * 8, None])
def test_credentials_reject_invalid_password_with_stable_error(password: object) -> None:
    with pytest.raises(AuthError) as raised:
        AuthCredentials("alice", password)  # type: ignore[arg-type]

    assert raised.value.code is AuthErrorCode.INVALID_PASSWORD
    assert raised.value.message == "Invalid password"
    assert repr(raised.value) == "AuthError('Invalid password')"


def test_credentials_use_unicode_code_points_without_case_or_normalization_changes() -> None:
    decomposed = "A\u030alice"

    credentials = AuthCredentials(decomposed, "密码password")

    assert credentials.username == decomposed
    assert (
        AuthCredentials("Alice", "password").username
        != AuthCredentials("alice", "password").username
    )
