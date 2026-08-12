"""Argon2id 密码哈希器测试。"""

import pytest
from argon2.exceptions import HashingError
from pwdlib import PasswordHash

from timeflow.infrastructure.security import Argon2PasswordHasher


def test_hash_uses_argon2id_with_a_unique_salt() -> None:
    hasher = Argon2PasswordHasher()
    password = "correct horse battery staple"

    first_hash = hasher.hash(password)
    second_hash = hasher.hash(password)

    assert first_hash.startswith("$argon2id$")
    assert second_hash.startswith("$argon2id$")
    assert first_hash != second_hash
    assert password not in first_hash
    assert password not in second_hash


def test_verify_accepts_only_the_correct_password() -> None:
    hasher = Argon2PasswordHasher()
    password_hash = hasher.hash("correct horse battery staple")

    assert hasher.verify("correct horse battery staple", password_hash) is True
    assert hasher.verify("wrong password", password_hash) is False
    assert hasher.verify("", password_hash) is False


def test_verify_rejects_unknown_or_malformed_hash_without_logging_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    hasher = Argon2PasswordHasher()
    password = "never-log-this-password"
    hashes = ("not-a-password-hash", "$argon2id$invalid-hash")

    assert all(hasher.verify(password, password_hash) is False for password_hash in hashes)
    assert password not in caplog.text
    assert all(password_hash not in caplog.text for password_hash in hashes)


def test_hash_normalizes_provider_error_without_revealing_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hasher = Argon2PasswordHasher()
    password = "never-expose-this-password"

    def fail_hash(_password_hash: PasswordHash, _password: str) -> str:
        raise HashingError(password)

    monkeypatch.setattr(PasswordHash, "hash", fail_hash)

    with pytest.raises(RuntimeError, match="^Password hashing failed$") as raised:
        hasher.hash(password)

    assert password not in str(raised.value)
    assert raised.value.__suppress_context__ is True
