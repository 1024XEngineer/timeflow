"""账户访问的无框架编排测试。"""

from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType

import pytest

from timeflow.business.auth import (
    AccountRecord,
    AuthAccessService,
    AuthError,
    AuthErrorCode,
    NewAccount,
    UsernameConflictError,
)

NOW = datetime(2026, 8, 12, 8, tzinfo=UTC)


class _Hasher:
    def __init__(self) -> None:
        self.hashed: list[str] = []
        self.verified: list[tuple[str, str]] = []

    def hash(self, password: str) -> str:
        self.hashed.append(password)
        return f"hashed:{password}"

    def verify(self, password: str, password_hash: str) -> bool:
        self.verified.append((password, password_hash))
        return password_hash == f"hashed:{password}"


@dataclass(frozen=True)
class _IssuedToken:
    access_token: str
    expires_in: int


class _Tokens:
    def __init__(self) -> None:
        self.issued_for: list[str] = []

    def issue(self, account_id: str) -> _IssuedToken:
        self.issued_for.append(account_id)
        return _IssuedToken(f"token:{account_id}", 3600)

    def verify(self, token: str) -> str | None:
        return token.removeprefix("token:") if token.startswith("token:") else None


class _Repository:
    def __init__(self, store: dict[str, AccountRecord], *, conflict: AccountRecord | None) -> None:
        self._store = store
        self._conflict = conflict

    def get_by_username(self, username: str) -> AccountRecord | None:
        return self._store.get(username)

    def add(self, account: NewAccount) -> AccountRecord:
        if self._conflict is not None:
            self._store[self._conflict.username] = self._conflict
            raise UsernameConflictError
        record = AccountRecord(account.id, account.username, account.password_hash)
        self._store[account.username] = record
        return record


class _UnitOfWork:
    def __init__(
        self,
        store: dict[str, AccountRecord],
        events: list[str],
        *,
        conflict: AccountRecord | None = None,
    ) -> None:
        self.accounts = _Repository(store, conflict=conflict)
        self._events = events
        self.committed = False

    def __enter__(self) -> "_UnitOfWork":
        self._events.append("enter")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._events.append(f"exit:{exc_type.__name__ if exc_type else 'none'}")

    def commit(self) -> None:
        self.committed = True
        self._events.append("commit")

    def rollback(self) -> None:
        self._events.append("rollback")


class _Factory:
    def __init__(
        self,
        initial: AccountRecord | None = None,
        *,
        conflict: AccountRecord | None = None,
    ) -> None:
        self.store = {} if initial is None else {initial.username: initial}
        self.events: list[str] = []
        self.created: list[_UnitOfWork] = []
        self._conflict = conflict

    def __call__(self) -> _UnitOfWork:
        conflict = self._conflict if not self.created else None
        unit_of_work = _UnitOfWork(self.store, self.events, conflict=conflict)
        self.created.append(unit_of_work)
        return unit_of_work


def _service(
    factory: _Factory,
) -> tuple[AuthAccessService, _Hasher, _Tokens]:
    hasher = _Hasher()
    tokens = _Tokens()
    service = AuthAccessService(
        factory,
        hasher,
        tokens,
        clock=lambda: NOW,
        id_factory=lambda: "generated-id",
    )
    return service, hasher, tokens


def test_access_normalizes_and_creates_account_before_issuing_token() -> None:
    factory = _Factory()
    service, hasher, tokens = _service(factory)

    result = service.access("  alice  ", "password")

    account = factory.store["alice"]
    assert account == AccountRecord("acc_generated-id", "alice", "hashed:password")
    assert result.account_id == account.id
    assert result.access_token == f"token:{account.id}"
    assert result.expires_in == 3600
    assert "token:" not in repr(result)
    assert hasher.hashed == ["password"]
    assert hasher.verified == []
    assert tokens.issued_for == [account.id]
    assert factory.created[0].committed is True
    assert factory.events == ["enter", "commit", "exit:none"]


def test_access_verifies_existing_account_without_hashing_or_writing() -> None:
    existing = AccountRecord("acc_existing", "alice", "hashed:password")
    factory = _Factory(existing)
    service, hasher, tokens = _service(factory)

    result = service.access("alice", "password")

    assert result.account_id == existing.id
    assert hasher.hashed == []
    assert hasher.verified == [("password", "hashed:password")]
    assert tokens.issued_for == [existing.id]
    assert factory.created[0].committed is False


def test_access_rejects_wrong_existing_password_without_issuing_token() -> None:
    factory = _Factory(AccountRecord("acc_existing", "alice", "hashed:other-pass"))
    service, _, tokens = _service(factory)

    with pytest.raises(AuthError) as raised:
        service.access("alice", "password")

    assert raised.value.code is AuthErrorCode.INVALID_CREDENTIALS
    assert raised.value.message == "Invalid username or password"
    assert tokens.issued_for == []


@pytest.mark.parametrize(
    ("winner_hash", "expected_success"),
    [("hashed:password", True), ("hashed:other-pass", False)],
)
def test_access_discards_conflicted_transaction_and_verifies_winner(
    winner_hash: str,
    expected_success: bool,
) -> None:
    winner = AccountRecord("acc_winner", "alice", winner_hash)
    factory = _Factory(conflict=winner)
    service, hasher, tokens = _service(factory)

    if expected_success:
        assert service.access("alice", "password").account_id == winner.id
    else:
        with pytest.raises(AuthError) as raised:
            service.access("alice", "password")
        assert raised.value.code is AuthErrorCode.INVALID_CREDENTIALS

    assert len(factory.created) == 2
    assert factory.events[:3] == ["enter", "exit:UsernameConflictError", "enter"]
    assert hasher.hashed == ["password"]
    assert hasher.verified == [("password", winner_hash)]
    assert tokens.issued_for == ([winner.id] if expected_success else [])


def test_access_fails_closed_if_conflict_winner_is_not_visible() -> None:
    factory = _Factory(conflict=AccountRecord("acc_winner", "bob", "hashed:password"))
    service, _, tokens = _service(factory)

    with pytest.raises(RuntimeError, match="not visible"):
        service.access("alice", "password")

    assert len(factory.created) == 2
    assert tokens.issued_for == []


def test_access_rejects_generated_account_id_beyond_schema_limit() -> None:
    service = AuthAccessService(
        _Factory(),
        _Hasher(),
        _Tokens(),
        clock=lambda: NOW,
        id_factory=lambda: "x" * 61,
    )

    with pytest.raises(RuntimeError, match="persistence limit"):
        service.access("alice", "password")
