"""Repository tests for account isolation and optimistic persistence primitives."""

from collections.abc import Generator
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from timeflow.business.calendar import (
    OccurrenceOverrideAction,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.data.database import Base
from timeflow.data.repositories import ScheduleRepository


@pytest.fixture
def session() -> Generator[Session, None, None]:
    """Return an isolated SQLAlchemy session for repository behavior tests."""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database_session:
        yield database_session


def _schedule(
    schedule_id: str,
    account_id: str,
    *,
    revision: int = 1,
) -> ScheduleSnapshot:
    now = datetime.now(UTC)
    return ScheduleSnapshot(
        id=schedule_id,
        account_id=account_id,
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title=f"Schedule {schedule_id}",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=revision,
        created_at=now,
        updated_at=now,
        start_time=now,
    )


def test_schedule_reads_are_account_scoped(session: Session) -> None:
    """An account can never load rows owned by another account."""
    repository = ScheduleRepository(session)
    repository.add_schedule(_schedule("schedule-a", "account-a"))
    repository.add_schedule(_schedule("schedule-b", "account-b"))

    assert repository.get_schedule(account_id="account-a", schedule_id="schedule-b") is None
    account_schedules = repository.list_schedules(account_id="account-a")
    assert [snapshot.id for snapshot in account_schedules] == ["schedule-a"]


def test_schedule_update_requires_matching_account_and_revision(session: Session) -> None:
    """The persistence update is a single optimistic conditional statement."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a"))
    updated = replace(original, title="Updated", revision=2, updated_at=datetime.now(UTC))

    assert repository.update_schedule(snapshot=updated, expected_revision=0) is None
    persisted = repository.update_schedule(snapshot=updated, expected_revision=1)

    assert persisted is not None
    assert persisted.title == "Updated"
    assert persisted.revision == 2


def test_schedule_update_preserves_immutable_creation_time(session: Session) -> None:
    """A replacement snapshot cannot rewrite the persisted creation timestamp."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a"))
    caller_created_at = datetime(2020, 1, 1, tzinfo=UTC)
    updated = replace(
        original,
        title="Updated",
        revision=2,
        created_at=caller_created_at,
        updated_at=datetime.now(UTC),
    )

    persisted = repository.update_schedule(snapshot=updated, expected_revision=1)

    assert persisted is not None
    assert persisted.created_at == original.created_at.replace(tzinfo=None)
    assert persisted.created_at != caller_created_at.replace(tzinfo=None)


def test_deleted_schedules_are_hidden_by_default(session: Session) -> None:
    """Soft-deleted rows remain available only to explicit snapshot queries."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a"))
    deleted = replace(
        original,
        status=ScheduleStatus.DELETED,
        revision=2,
        updated_at=datetime.now(UTC),
        deleted_at=datetime.now(UTC),
    )
    assert repository.update_schedule(snapshot=deleted, expected_revision=1) is not None

    assert repository.get_schedule(account_id="account-a", schedule_id="schedule-a") is None
    assert (
        repository.get_schedule(
            account_id="account-a",
            schedule_id="schedule-a",
            include_deleted=True,
        )
        is not None
    )


def test_occurrence_overrides_are_account_scoped(session: Session) -> None:
    """Override writes and reads follow ownership through their parent schedule."""
    repository = ScheduleRepository(session)
    parent = repository.add_schedule(_schedule("series-a", "account-a"))
    repository.add_schedule(_schedule("series-b", "account-b"))
    now = datetime.now(UTC)
    override = ScheduleOccurrenceOverrideSnapshot(
        id="override-a",
        schedule_id=parent.id,
        occurrence_start=now,
        action=OccurrenceOverrideAction.CANCEL,
        created_at=now,
        updated_at=now,
    )

    assert repository.add_occurrence_override(account_id="account-b", snapshot=override) is None
    assert repository.add_occurrence_override(account_id="account-a", snapshot=override) == override
    assert repository.list_occurrence_overrides(account_id="account-b") == ()
    account_overrides = repository.list_occurrence_overrides(account_id="account-a")
    assert [snapshot.id for snapshot in account_overrides] == ["override-a"]
    assert account_overrides[0].action is OccurrenceOverrideAction.CANCEL
