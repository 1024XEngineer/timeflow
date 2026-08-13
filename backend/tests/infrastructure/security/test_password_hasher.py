"""Argon2id 密码哈希器测试。"""

import pytest
from pwdlib import PasswordHash

from timeflow.infrastructure.security.password_hasher import Argon2PasswordHasher


def test_hash_uses_argon2id_with_a_unique_salt() -> None:
    hasher = Argon2PasswordHasher()

    first_hash = hasher.hash("correct horse battery staple")
    second_hash = hasher.hash("correct horse battery staple")

    assert first_hash.startswith("$argon2id$")
    assert second_hash.startswith("$argon2id$")
    assert first_hash != second_hash
    assert "correct horse battery staple" not in first_hash


def test_verify_accepts_only_the_correct_password() -> None:
    hasher = Argon2PasswordHasher()
    password_hash = hasher.hash("correct horse battery staple")

    assert hasher.verify("correct horse battery staple", password_hash) is True
    assert hasher.verify("wrong password", password_hash) is False
    assert hasher.verify("", password_hash) is False


def test_verify_normalizes_malformed_hashes_without_logging_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    hasher = Argon2PasswordHasher()
    password = "never-log-this-password"
    malformed_hash = "$argon2id$never-log-this-hash"

    assert hasher.verify(password, malformed_hash) is False

    assert password not in caplog.text
    assert malformed_hash not in caplog.text


def test_hash_normalizes_provider_errors_without_revealing_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hasher = Argon2PasswordHasher()
    password = "never-expose-this-password"

    def raise_error(_password: str) -> str:
        raise RuntimeError(password)

    monkeypatch.setattr(PasswordHash, "hash", raise_error)

    with pytest.raises(RuntimeError, match="Password hashing failed") as error:
        hasher.hash(password)

    assert password not in str(error.value)
    assert error.value.__suppress_context__ is True
