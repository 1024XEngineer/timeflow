"""PostgreSQL integration tests for the schedule persistence adapter."""

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    OccurrenceOverrideAction,
    RecurringDeleteScope,
    ScheduleApplicationService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    UpdateScheduleCommand,
)
from timeflow.data.models import Account, ScheduleOccurrenceOverride
from timeflow.data.repositories import ScheduleRepository, ScheduleRevisionConflictError
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork


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


def test_postgres_schedule_candidates_keep_old_recurring_series_and_bound_once_rows(
    postgres_session: Session,
) -> None:
    """PostgreSQL performs only the safe coarse filter needed before RRULE expansion."""
    _seed_account(postgres_session, "account-a")
    _seed_account(postgres_session, "account-b")
    repository = ScheduleRepository(postgres_session)
    lower = datetime(2026, 8, 17, tzinfo=UTC)
    upper = datetime(2026, 8, 18, tzinfo=UTC)
    recurring = replace(
        _schedule("recurring-old", "account-a"),
        schedule_kind=ScheduleKind.RECURRING,
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
        recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
    )
    rows = (
        recurring,
        replace(_schedule("once-inside", "account-a"), start_time=lower),
        replace(_schedule("once-at-end", "account-a"), start_time=upper),
        replace(
            _schedule("deleted-inside", "account-a"),
            start_time=lower,
            status=ScheduleStatus.DELETED,
            deleted_at=lower,
        ),
        replace(_schedule("other-account", "account-b"), start_time=lower),
    )
    for row in rows:
        repository.add_schedule(row)

    candidates = repository.list_schedule_candidates(
        account_id="account-a",
        starts_at_or_after=lower,
        starts_before=upper,
    )

    assert [schedule.id for schedule in candidates] == ["recurring-old", "once-inside"]


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


def _application_service(
    postgres_connection: Connection,
    *,
    account_id: str,
    ids: Iterator[str],
    now: datetime,
) -> ScheduleApplicationService:
    factory = sessionmaker(
        bind=postgres_connection,
        join_transaction_mode="create_savepoint",
        expire_on_commit=False,
    )
    with factory() as session:
        _seed_account(session, account_id)
        session.commit()
    return ScheduleApplicationService(
        lambda: SqlAlchemyScheduleUnitOfWork(factory),
        clock=lambda: now,
        id_factory=lambda: next(ids),
    )


def test_postgres_application_service_commits_create_update_and_soft_delete(
    postgres_connection: Connection,
) -> None:
    """The application service returns each PostgreSQL-committed final snapshot."""
    account_id = "account-service-crud"
    now = datetime(2026, 8, 11, 1, tzinfo=UTC)
    service = _application_service(
        postgres_connection,
        account_id=account_id,
        ids=iter(("schedule-service-crud",)),
        now=now,
    )
    command = CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title="Project sync",
        timezone="Asia/Shanghai",
        start_time=datetime(2026, 8, 12, 7, tzinfo=UTC),
    )

    created = service.create_schedule(account_id=account_id, command=command).schedules[0]
    updated = service.update_schedule(
        account_id=account_id,
        command=UpdateScheduleCommand(created.id, 1, {"title": "Updated sync"}),
    ).schedules[0]
    deleted = service.delete_once_schedule(
        account_id=account_id,
        command=DeleteOnceScheduleCommand(updated.id, 2),
    ).schedules[0]

    assert created.revision == 1
    assert updated.revision == 2
    assert updated.title == "Updated sync"
    assert deleted.revision == 3
    assert deleted.status is ScheduleStatus.DELETED
    found = service.find_schedules(
        account_id=account_id,
        query=FindSchedulesQuery(schedule_id=deleted.id, include_deleted=True),
    )
    assert found.schedules == (deleted,)

    with pytest.raises(ScheduleBusinessError) as raised:
        service.update_schedule(
            account_id=account_id,
            command=UpdateScheduleCommand(deleted.id, 2, {"title": "Stale"}),
        )
    assert raised.value.code is ScheduleErrorCode.SCHEDULE_NOT_FOUND


def test_postgres_application_service_atomically_cancels_current_occurrence(
    postgres_connection: Connection,
) -> None:
    """Occurrence cancellation and parent revision commit in one PostgreSQL transaction."""
    account_id = "account-service-recurring"
    now = datetime(2026, 8, 11, 1, tzinfo=UTC)
    service = _application_service(
        postgres_connection,
        account_id=account_id,
        ids=iter(("schedule-service-recurring", "override-service-recurring")),
        now=now,
    )
    created = service.create_schedule(
        account_id=account_id,
        command=CreateScheduleCommand(
            schedule_type=ScheduleType.TIME,
            schedule_kind=ScheduleKind.RECURRING,
            title="Weekly sync",
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    result = service.delete_recurring_schedule(
        account_id=account_id,
        command=DeleteRecurringScheduleCommand(
            created.id,
            1,
            RecurringDeleteScope.THIS_OCCURRENCE,
        ),
    )

    assert result.schedules[0].revision == 2
    assert result.occurrence_overrides[0].action is OccurrenceOverrideAction.CANCEL
    assert result.occurrence_overrides[0].occurrence_start == datetime(2026, 8, 17, 2, tzinfo=UTC)


def test_postgres_entire_series_atomically_soft_deletes_replacement(
    postgres_connection: Connection,
) -> None:
    """The parent and its replacement commit as one PostgreSQL mutation."""
    account_id = "account-service-replacement-delete"
    now = datetime(2026, 8, 11, 1, tzinfo=UTC)
    service = _application_service(
        postgres_connection,
        account_id=account_id,
        ids=iter(("recurring-with-replacement", "replacement-once")),
        now=now,
    )
    recurring = service.create_schedule(
        account_id=account_id,
        command=CreateScheduleCommand(
            schedule_type=ScheduleType.TIME,
            schedule_kind=ScheduleKind.RECURRING,
            title="Weekly sync",
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    replacement = service.create_schedule(
        account_id=account_id,
        command=CreateScheduleCommand(
            schedule_type=ScheduleType.TIME,
            schedule_kind=ScheduleKind.ONCE,
            title="Moved sync",
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 17, 6, tzinfo=UTC),
        ),
    ).schedules[0]
    with Session(
        bind=postgres_connection,
        join_transaction_mode="create_savepoint",
    ) as session:
        repository = ScheduleRepository(session)
        persisted_override = repository.add_occurrence_override(
            account_id=account_id,
            snapshot=ScheduleOccurrenceOverrideSnapshot(
                id="replace-override",
                schedule_id=recurring.id,
                occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
                action=OccurrenceOverrideAction.REPLACE,
                replacement_schedule_id=replacement.id,
                created_at=now,
                updated_at=now,
            ),
        )
        assert persisted_override is not None
        session.commit()

    result = service.delete_recurring_schedule(
        account_id=account_id,
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            recurring.revision,
            RecurringDeleteScope.ENTIRE_SERIES,
        ),
    )

    assert [schedule.id for schedule in result.schedules] == [
        recurring.id,
        replacement.id,
    ]
    assert all(schedule.status is ScheduleStatus.DELETED for schedule in result.schedules)
    assert all(schedule.revision == 2 for schedule in result.schedules)
    for schedule in result.schedules:
        found = service.find_schedules(
            account_id=account_id,
            query=FindSchedulesQuery(
                schedule_id=schedule.id,
                include_deleted=True,
            ),
        )
        assert found.schedules == (schedule,)
