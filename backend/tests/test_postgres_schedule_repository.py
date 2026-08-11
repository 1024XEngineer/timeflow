"""PostgreSQL integration tests for the schedule persistence adapter."""

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from timeflow.business.calendar import (
    OccurrenceOverrideAction,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.data.models import Account, ScheduleOccurrenceOverride
from timeflow.data.repositories import ScheduleRepository, ScheduleRevisionConflictError


@pytest.fixture
def postgres_session(postgres_connection: Connection) -> Iterator[Session]:
    """Join the shared rollback transaction through a test-owned savepoint."""
    with Session(
        bind=postgres_connection,
        join_transaction_mode="create_savepoint",
    ) as session:
        yield session


def _seed_account(session: Session, account_id: str) -> None:
    now = datetime.now(UTC)
    session.add(
        Account(
            id=account_id,
            username=f"{account_id}@example.com",
            password_hash="test-password-hash",
            created_at=now,
            updated_at=now,
        )
    )
    session.flush()


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


def test_postgres_repository_insert_and_update_return_final_revision(
    postgres_session: Session,
) -> None:
    """PostgreSQL RETURNING exposes the row after its atomic revision increment."""
    _seed_account(postgres_session, "account-a")
    repository = ScheduleRepository(postgres_session)
    inserted = repository.add_schedule(_schedule("schedule-a", "account-a", revision=5))

    assert inserted.revision == 5

    caller_snapshot = replace(
        inserted,
        title="Updated",
        revision=1,
        updated_at=datetime.now(UTC),
    )
    updated = repository.update_schedule(snapshot=caller_snapshot, expected_revision=5)

    assert updated is not None
    assert updated.title == "Updated"
    assert updated.revision == 6
    assert updated.created_at == inserted.created_at


def test_postgres_repository_reports_conflict_and_preserves_account_isolation(
    postgres_session: Session,
) -> None:
    """A stale owner gets a conflict while another account observes no target row."""
    _seed_account(postgres_session, "account-a")
    _seed_account(postgres_session, "account-b")
    repository = ScheduleRepository(postgres_session)
    inserted = repository.add_schedule(_schedule("schedule-a", "account-a", revision=5))
    stale = replace(inserted, title="Stale", revision=100, updated_at=datetime.now(UTC))

    with pytest.raises(ScheduleRevisionConflictError) as raised:
        repository.update_schedule(snapshot=stale, expected_revision=4)

    assert raised.value.actual_revision == 5

    wrong_owner = replace(stale, account_id="account-b")
    assert repository.update_schedule(snapshot=wrong_owner, expected_revision=5) is None
    persisted = repository.get_schedule(account_id="account-a", schedule_id=inserted.id)
    assert persisted is not None
    assert persisted.title == inserted.title
    assert persisted.revision == 5


def test_postgres_repository_updates_one_unique_occurrence_override(
    postgres_session: Session,
) -> None:
    """One occurrence can change action without duplicating its unique key."""
    _seed_account(postgres_session, "account-a")
    repository = ScheduleRepository(postgres_session)
    parent = repository.add_schedule(_schedule("series-a", "account-a", revision=5))
    replacement = repository.add_schedule(_schedule("replacement-a", "account-a"))
    now = datetime.now(UTC)
    original = ScheduleOccurrenceOverrideSnapshot(
        id="override-a",
        schedule_id=parent.id,
        occurrence_start=now,
        action=OccurrenceOverrideAction.CANCEL,
        created_at=now,
        updated_at=now,
    )
    repository.add_occurrence_override(account_id="account-a", snapshot=original)

    updated = repository.update_occurrence_override(
        account_id="account-a",
        schedule_id=parent.id,
        occurrence_start=now,
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=replacement.id,
        updated_at=datetime.now(UTC),
    )

    assert updated is not None
    assert updated.id == original.id
    assert updated.action is OccurrenceOverrideAction.REPLACE
    assert updated.replacement_schedule_id == replacement.id
    persisted_parent = repository.get_schedule(account_id="account-a", schedule_id=parent.id)
    assert persisted_parent is not None
    assert persisted_parent.revision == 5

    duplicate = replace(original, id="override-duplicate")
    with pytest.raises(sa.exc.IntegrityError):
        with postgres_session.begin_nested():
            repository.add_occurrence_override(account_id="account-a", snapshot=duplicate)


def test_postgres_repository_and_database_enforce_override_ownership_and_fk(
    postgres_session: Session,
) -> None:
    """Repository ownership checks complement the PostgreSQL foreign key."""
    _seed_account(postgres_session, "account-a")
    _seed_account(postgres_session, "account-b")
    repository = ScheduleRepository(postgres_session)
    parent = repository.add_schedule(_schedule("series-a", "account-a"))
    other_account_replacement = repository.add_schedule(_schedule("replacement-b", "account-b"))
    now = datetime.now(UTC)
    cross_account = ScheduleOccurrenceOverrideSnapshot(
        id="override-cross-account",
        schedule_id=parent.id,
        occurrence_start=now,
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=other_account_replacement.id,
        created_at=now,
        updated_at=now,
    )

    assert (
        repository.add_occurrence_override(account_id="account-a", snapshot=cross_account) is None
    )

    with pytest.raises(sa.exc.IntegrityError):
        with postgres_session.begin_nested():
            postgres_session.add(
                ScheduleOccurrenceOverride(
                    id="override-missing-parent",
                    schedule_id="missing-series",
                    occurrence_start=now,
                    action=OccurrenceOverrideAction.CANCEL.value,
                    replacement_schedule_id=None,
                    created_at=now,
                    updated_at=now,
                )
            )
            postgres_session.flush()


def test_postgres_repository_respects_caller_transaction_rollback(
    postgres_engine: Engine,
) -> None:
    """Repository flushes are discarded when the owning transaction rolls back."""
    account_id = "account-rollback"
    schedule_id = "schedule-rollback"
    with Session(postgres_engine) as session:
        _seed_account(session, account_id)
        repository = ScheduleRepository(session)
        repository.add_schedule(_schedule(schedule_id, account_id))
        session.rollback()

    with Session(postgres_engine) as verification_session:
        repository = ScheduleRepository(verification_session)
        assert repository.get_schedule(account_id=account_id, schedule_id=schedule_id) is None
