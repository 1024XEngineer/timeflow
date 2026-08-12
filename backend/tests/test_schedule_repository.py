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
from timeflow.data.models import Account
from timeflow.data.repositories import ScheduleRepository, ScheduleRevisionConflictError


@pytest.fixture
def session() -> Generator[Session, None, None]:
    """Return an isolated SQLAlchemy session for repository behavior tests."""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database_session:
        now = datetime.now(UTC)
        database_session.add_all(
            [
                Account(
                    id=account_id,
                    username=f"{account_id}@example.com",
                    password_hash="test-password-hash",
                    created_at=now,
                    updated_at=now,
                )
                for account_id in ("account-a", "account-b")
            ]
        )
        database_session.flush()
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


def test_schedule_candidates_coarsely_filter_once_rows_and_keep_recurring_series(
    session: Session,
) -> None:
    """Candidate SQL bounds one-time starts without dropping older recurring series."""
    repository = ScheduleRepository(session)
    lower = datetime(2026, 8, 17, tzinfo=UTC)
    upper = datetime(2026, 8, 18, tzinfo=UTC)
    recurring = replace(
        _schedule("recurring-old", "account-a"),
        schedule_kind=ScheduleKind.RECURRING,
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
        recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
    )
    once_inside = replace(_schedule("once-inside", "account-a"), start_time=lower)
    once_at_exclusive_end = replace(
        _schedule("once-at-end", "account-a"),
        start_time=upper,
    )
    deleted_inside = replace(
        _schedule("deleted-inside", "account-a"),
        start_time=lower,
        status=ScheduleStatus.DELETED,
        deleted_at=lower,
    )
    other_account = replace(_schedule("other-account", "account-b"), start_time=lower)
    for schedule in (
        recurring,
        once_inside,
        once_at_exclusive_end,
        deleted_inside,
        other_account,
    ):
        repository.add_schedule(schedule)

    candidates = repository.list_schedule_candidates(
        account_id="account-a",
        starts_at_or_after=lower,
        starts_before=upper,
    )

    assert [schedule.id for schedule in candidates] == ["recurring-old", "once-inside"]


def test_schedule_update_atomically_increments_revision(session: Session) -> None:
    """The database revision advances regardless of the caller snapshot value."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a", revision=5))
    unchanged_revision = replace(
        original,
        title="Updated once",
        revision=5,
        updated_at=datetime.now(UTC),
    )

    persisted = repository.update_schedule(snapshot=unchanged_revision, expected_revision=5)

    assert persisted is not None
    assert persisted.title == "Updated once"
    assert persisted.revision == 6

    lower_revision = replace(
        persisted,
        title="Updated twice",
        revision=1,
        updated_at=datetime.now(UTC),
    )
    persisted_again = repository.update_schedule(snapshot=lower_revision, expected_revision=6)

    assert persisted_again is not None
    assert persisted_again.title == "Updated twice"
    assert persisted_again.revision == 7


def test_schedule_update_raises_explicit_revision_conflict(session: Session) -> None:
    """A stale expected revision is distinguishable from a missing schedule."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a", revision=5))
    updated = replace(original, title="Stale update", revision=100, updated_at=datetime.now(UTC))

    with pytest.raises(ScheduleRevisionConflictError) as raised:
        repository.update_schedule(snapshot=updated, expected_revision=4)

    assert raised.value.schedule_id == original.id
    assert raised.value.expected_revision == 4
    assert raised.value.actual_revision == 5
    persisted = repository.get_schedule(account_id="account-a", schedule_id=original.id)
    assert persisted is not None
    assert persisted.title == original.title
    assert persisted.revision == 5


def test_schedule_update_cannot_cross_account_boundary(session: Session) -> None:
    """An otherwise valid revision cannot update another account's schedule."""
    repository = ScheduleRepository(session)
    original = repository.add_schedule(_schedule("schedule-a", "account-a", revision=5))
    wrong_owner = replace(
        original,
        account_id="account-b",
        title="Cross-account update",
        revision=100,
        updated_at=datetime.now(UTC),
    )

    assert repository.update_schedule(snapshot=wrong_owner, expected_revision=5) is None
    persisted = repository.get_schedule(account_id="account-a", schedule_id=original.id)
    assert persisted is not None
    assert persisted.title == original.title
    assert persisted.revision == 5


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


def test_occurrence_override_can_be_updated_without_hidden_revision_change(
    session: Session,
) -> None:
    """Override persistence changes one unique occurrence but not its parent aggregate."""
    repository = ScheduleRepository(session)
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
    assert updated.created_at.replace(tzinfo=UTC) == original.created_at
    persisted_parent = repository.get_schedule(account_id="account-a", schedule_id=parent.id)
    assert persisted_parent is not None
    assert persisted_parent.revision == 5


def test_occurrence_override_update_is_account_scoped(session: Session) -> None:
    """An account cannot modify an override through another account's parent."""
    repository = ScheduleRepository(session)
    parent = repository.add_schedule(_schedule("series-a", "account-a"))
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

    assert (
        repository.update_occurrence_override(
            account_id="account-b",
            schedule_id=parent.id,
            occurrence_start=now,
            action=OccurrenceOverrideAction.REPLACE,
            replacement_schedule_id=None,
            updated_at=datetime.now(UTC),
        )
        is None
    )
    persisted = repository.get_occurrence_override(
        account_id="account-a",
        override_id=original.id,
    )
    assert persisted is not None
    assert persisted.action is OccurrenceOverrideAction.CANCEL
