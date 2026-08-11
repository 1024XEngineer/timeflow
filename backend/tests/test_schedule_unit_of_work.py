"""Transaction-boundary tests for the SQLAlchemy schedule adapter."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from timeflow.business.calendar import (
    ScheduleKind,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.data.database import Base
from timeflow.data.models import Account
from timeflow.data.repositories import ScheduleRepository
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork


def _factory() -> sessionmaker[Session]:
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime.now(UTC)
    with factory() as session:
        session.add(
            Account(
                id="account-a",
                username="account-a@example.com",
                password_hash="test-password-hash",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
    return factory


def _schedule(schedule_id: str) -> ScheduleSnapshot:
    now = datetime.now(UTC)
    return ScheduleSnapshot(
        id=schedule_id,
        account_id="account-a",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title="Schedule",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=1,
        created_at=now,
        updated_at=now,
        start_time=now,
    )


def test_unit_of_work_commits_repository_flushes() -> None:
    factory = _factory()

    with SqlAlchemyScheduleUnitOfWork(factory) as unit_of_work:
        unit_of_work.schedules.add_schedule(_schedule("committed"))
        unit_of_work.commit()

    with factory() as session:
        persisted = ScheduleRepository(session).get_schedule(
            account_id="account-a",
            schedule_id="committed",
        )
    assert persisted is not None


def test_unit_of_work_rolls_back_on_error_or_missing_commit() -> None:
    factory = _factory()

    with pytest.raises(RuntimeError, match="stop transaction"):
        with SqlAlchemyScheduleUnitOfWork(factory) as unit_of_work:
            unit_of_work.schedules.add_schedule(_schedule("rolled-back-error"))
            raise RuntimeError("stop transaction")
    with SqlAlchemyScheduleUnitOfWork(factory) as unit_of_work:
        unit_of_work.schedules.add_schedule(_schedule("rolled-back-close"))

    with factory() as session:
        repository = ScheduleRepository(session)
        assert (
            repository.get_schedule(
                account_id="account-a",
                schedule_id="rolled-back-error",
            )
            is None
        )
        assert (
            repository.get_schedule(
                account_id="account-a",
                schedule_id="rolled-back-close",
            )
            is None
        )


def test_unit_of_work_rejects_commit_outside_context() -> None:
    unit_of_work = SqlAlchemyScheduleUnitOfWork(_factory())

    with pytest.raises(RuntimeError, match="not active"):
        unit_of_work.commit()
