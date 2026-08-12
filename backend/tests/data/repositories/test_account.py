"""账户持久化及事务适配器的 SQLite 测试。"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from timeflow.business.auth import NewAccount, UsernameConflictError
from timeflow.data.account_uow import SqlAlchemyAuthUnitOfWork
from timeflow.data.database import Base
from timeflow.data.repositories import AccountRepository

NOW = datetime(2026, 8, 12, 8, tzinfo=UTC)


@pytest.fixture
def session_factory() -> sessionmaker[Session]:
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


def _account(
    account_id: str = "acc_alice",
    username: str = "alice",
) -> NewAccount:
    return NewAccount(account_id, username, "hashed:password", NOW, NOW)


def test_repository_adds_and_reads_framework_independent_record(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        repository = AccountRepository(session)
        assert repository.get_by_username("missing") is None

        added = repository.add(_account())

        assert added.id == "acc_alice"
        assert added.username == "alice"
        assert added.password_hash == "hashed:password"
        assert "hashed:password" not in repr(added)
        assert repository.get_by_username("alice") == added


def test_repository_flush_does_not_commit_owner_transaction(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        AccountRepository(session).add(_account())
        session.rollback()

    with session_factory() as session:
        assert AccountRepository(session).get_by_username("alice") is None


def test_repository_translates_only_username_unique_constraint(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        AccountRepository(session).add(_account())
        session.commit()

    with session_factory() as session:
        with pytest.raises(UsernameConflictError) as raised:
            AccountRepository(session).add(_account("acc_other"))
        assert str(raised.value) == ""
        session.rollback()

    with session_factory() as session:
        with pytest.raises(IntegrityError):
            AccountRepository(session).add(_account("acc_alice", "other-user"))


def test_auth_unit_of_work_commits_and_rolls_back_uncommitted_work(
    session_factory: sessionmaker[Session],
) -> None:
    with SqlAlchemyAuthUnitOfWork(session_factory) as unit_of_work:
        unit_of_work.accounts.add(_account("acc_committed", "committed"))
        unit_of_work.commit()
    with SqlAlchemyAuthUnitOfWork(session_factory) as unit_of_work:
        unit_of_work.accounts.add(_account("acc_rolled_back", "rolled-back"))

    with session_factory() as session:
        repository = AccountRepository(session)
        assert repository.get_by_username("committed") is not None
        assert repository.get_by_username("rolled-back") is None


def test_auth_unit_of_work_rolls_back_errors_and_explicit_rollback(
    session_factory: sessionmaker[Session],
) -> None:
    with pytest.raises(RuntimeError, match="stop"):
        with SqlAlchemyAuthUnitOfWork(session_factory) as unit_of_work:
            unit_of_work.accounts.add(_account("acc_error", "error"))
            raise RuntimeError("stop")
    with SqlAlchemyAuthUnitOfWork(session_factory) as unit_of_work:
        unit_of_work.accounts.add(_account("acc_explicit", "explicit"))
        unit_of_work.rollback()

    with session_factory() as session:
        repository = AccountRepository(session)
        assert repository.get_by_username("error") is None
        assert repository.get_by_username("explicit") is None


def test_auth_unit_of_work_rejects_invalid_lifecycle(
    session_factory: sessionmaker[Session],
) -> None:
    unit_of_work = SqlAlchemyAuthUnitOfWork(session_factory)
    with pytest.raises(RuntimeError, match="not active"):
        unit_of_work.commit()
    with unit_of_work:
        with pytest.raises(RuntimeError, match="already active"):
            unit_of_work.__enter__()
    with pytest.raises(RuntimeError, match="not active"):
        unit_of_work.rollback()
