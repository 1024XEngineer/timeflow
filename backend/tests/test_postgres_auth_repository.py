"""PostgreSQL 持久化及真实独立事务认证竞态测试。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Barrier, Lock
from types import TracebackType
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.auth import (
    AccountRecord,
    AccountRepositoryPort,
    AuthAccessService,
    AuthError,
    AuthErrorCode,
    AuthUnitOfWork,
    NewAccount,
)
from timeflow.data.account_uow import SqlAlchemyAuthUnitOfWork
from timeflow.data.models import Account
from timeflow.infrastructure.security import Argon2PasswordHasher


@dataclass(frozen=True)
class _Token:
    access_token: str
    expires_in: int = 3600


class _Tokens:
    def issue(self, account_id: str) -> _Token:
        return _Token(f"token:{account_id}")

    def verify(self, token: str) -> str | None:
        return token.removeprefix("token:") if token.startswith("token:") else None


class _BarrierRepository:
    def __init__(self, repository: AccountRepositoryPort, barrier: Barrier) -> None:
        self._repository = repository
        self._barrier = barrier

    def get_by_username(self, username: str) -> AccountRecord | None:
        result = self._repository.get_by_username(username)
        if result is None:
            self._barrier.wait(timeout=10)
        return result

    def add(self, account: NewAccount) -> AccountRecord:
        return self._repository.add(account)


class _BarrierUnitOfWork:
    def __init__(self, inner: SqlAlchemyAuthUnitOfWork, barrier: Barrier) -> None:
        self._inner = inner
        self._barrier = barrier
        self.accounts: AccountRepositoryPort

    def __enter__(self) -> "_BarrierUnitOfWork":
        self._inner.__enter__()
        self.accounts = _BarrierRepository(self._inner.accounts, self._barrier)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._inner.__exit__(exc_type, exc_value, traceback)

    def commit(self) -> None:
        self._inner.commit()

    def rollback(self) -> None:
        self._inner.rollback()


class _RacingFactory:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._barrier = Barrier(2)
        self._lock = Lock()
        self._calls = 0

    def __call__(self) -> AuthUnitOfWork:
        with self._lock:
            synchronize_initial_lookup = self._calls < 2
            self._calls += 1
        inner = SqlAlchemyAuthUnitOfWork(self._session_factory)
        if synchronize_initial_lookup:
            return _BarrierUnitOfWork(inner, self._barrier)
        return inner


@pytest.mark.parametrize("passwords", [("same-pass", "same-pass"), ("winner-a", "winner-b")])
def test_postgres_same_username_race_uses_one_winner_and_fresh_transaction(
    postgres_engine: Engine,
    passwords: tuple[str, str],
) -> None:
    suffix = uuid4().hex
    username = f"race-{suffix}"
    factory = sessionmaker(bind=postgres_engine, expire_on_commit=False)
    hasher = Argon2PasswordHasher()
    service = AuthAccessService(_RacingFactory(factory), hasher, _Tokens())

    def access(password: str) -> tuple[str, str]:
        try:
            result = service.access(username, password)
        except AuthError as error:
            assert error.code is AuthErrorCode.INVALID_CREDENTIALS
            return "error", error.code.value
        return "success", result.account_id

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(access, passwords))

        with Session(postgres_engine) as session:
            rows = list(session.scalars(sa.select(Account).where(Account.username == username)))
        assert len(rows) == 1
        assert rows[0].password_hash.startswith("$argon2id$")
        assert all(password not in rows[0].password_hash for password in passwords)
        if passwords[0] == passwords[1]:
            assert [status for status, _ in results] == ["success", "success"]
            assert results[0][1] == results[1][1] == rows[0].id
            assert hasher.verify(passwords[0], rows[0].password_hash)
        else:
            assert sorted(status for status, _ in results) == ["error", "success"]
            winning_password = passwords[[status for status, _ in results].index("success")]
            losing_password = passwords[[status for status, _ in results].index("error")]
            assert hasher.verify(winning_password, rows[0].password_hash)
            assert not hasher.verify(losing_password, rows[0].password_hash)
    finally:
        with postgres_engine.begin() as connection:
            connection.execute(sa.delete(Account).where(Account.username == username))


def test_postgres_auth_uow_persists_only_committed_account(postgres_engine: Engine) -> None:
    suffix = uuid4().hex
    committed_username = f"committed-{suffix}"
    rolled_back_username = f"rolled-back-{suffix}"
    factory = sessionmaker(bind=postgres_engine, expire_on_commit=False)

    def account(username: str) -> NewAccount:
        return NewAccount(
            f"acc_{uuid4().hex}",
            username,
            "test-hash:correct-password",
            _utc_now(),
            _utc_now(),
        )

    try:
        with SqlAlchemyAuthUnitOfWork(factory) as unit_of_work:
            unit_of_work.accounts.add(account(committed_username))
            unit_of_work.commit()
        with SqlAlchemyAuthUnitOfWork(factory) as unit_of_work:
            unit_of_work.accounts.add(account(rolled_back_username))

        with Session(postgres_engine) as session:
            persisted = list(
                session.scalars(
                    sa.select(Account).where(
                        Account.username.in_([committed_username, rolled_back_username])
                    )
                )
            )
        assert [record.username for record in persisted] == [committed_username]
    finally:
        with postgres_engine.begin() as connection:
            connection.execute(
                sa.delete(Account).where(
                    Account.username.in_([committed_username, rolled_back_username])
                )
            )


def _utc_now() -> datetime:
    return datetime.now(UTC)
