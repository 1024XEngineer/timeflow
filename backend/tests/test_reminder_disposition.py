"""Business tests for syncing a reminder's final confirmed state."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from types import TracebackType
from typing import cast

import pytest

from timeflow.business.calendar import (
    ReminderDispositionService,
    ReminderDispositionState,
    ReminderStrength,
    ReminderType,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.business.calendar.ports import ScheduleUnitOfWorkFactory

NOW = datetime(2026, 8, 17, 3, 30, tzinfo=UTC)
WINNER_TIME = datetime(2026, 8, 17, 3, 29, tzinfo=UTC)


def _schedule(
    *,
    schedule_id: str = "schedule-001",
    account_id: str = "account-a",
    kind: ScheduleKind = ScheduleKind.ONCE,
    reminder: bool = True,
    disposition_state: ReminderDispositionState | None = None,
    updated_at: datetime = datetime(2026, 8, 16, tzinfo=UTC),
    revision: int = 1,
) -> ScheduleSnapshot:
    return ScheduleSnapshot(
        id=schedule_id,
        account_id=account_id,
        schedule_type=ScheduleType.TIME,
        schedule_kind=kind,
        title="Take medicine",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=revision,
        created_at=datetime(2026, 8, 15, tzinfo=UTC),
        updated_at=updated_at,
        start_time=datetime(2026, 8, 18, tzinfo=UTC),
        recurrence_rule="FREQ=DAILY" if kind is ScheduleKind.RECURRING else None,
        reminder_type=ReminderType.BEFORE_START if reminder else None,
        reminder_offset_minutes=10 if reminder else None,
        reminder_strength=ReminderStrength.MEDIUM if reminder else None,
        reminder_disposition_state=disposition_state,
    )


@dataclass
class _Repository:
    reads: list[ScheduleSnapshot | None]
    update_result: ScheduleSnapshot | None = None
    confirm_calls: int = 0

    def get_schedule(
        self,
        *,
        account_id: str,
        schedule_id: str,
        include_deleted: bool = False,
    ) -> ScheduleSnapshot | None:
        del include_deleted
        snapshot = self.reads.pop(0)
        if snapshot is None:
            return None
        if snapshot.account_id != account_id or snapshot.id != schedule_id:
            return None
        return snapshot

    def confirm_reminder_disposition(
        self,
        *,
        account_id: str,
        schedule_id: str,
        confirmed_at: datetime,
    ) -> ScheduleSnapshot | None:
        del account_id, schedule_id, confirmed_at
        self.confirm_calls += 1
        return self.update_result


class _UnitOfWork:
    def __init__(self, repository: _Repository) -> None:
        self.schedules = repository
        self.commits = 0

    def __enter__(self) -> _UnitOfWork:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback

    def commit(self) -> None:
        self.commits += 1


def _service(repository: _Repository) -> tuple[ReminderDispositionService, _UnitOfWork]:
    unit_of_work = _UnitOfWork(repository)
    factory = cast(ScheduleUnitOfWorkFactory, lambda: unit_of_work)
    return ReminderDispositionService(factory, clock=lambda: NOW), unit_of_work


def test_first_confirmation_updates_once_and_commits() -> None:
    pending = _schedule()
    confirmed = replace(
        pending,
        reminder_disposition_state=ReminderDispositionState.CONFIRMED,
        updated_at=NOW,
        revision=2,
    )
    repository = _Repository(reads=[pending], update_result=confirmed)
    service, unit_of_work = _service(repository)

    result = service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert result.schedule_id == "schedule-001"
    assert result.disposition_state is ReminderDispositionState.CONFIRMED
    assert result.updated_at == NOW
    assert repository.confirm_calls == 1
    assert unit_of_work.commits == 1


def test_duplicate_confirmation_returns_existing_result_without_write_or_commit() -> None:
    confirmed = _schedule(
        disposition_state=ReminderDispositionState.CONFIRMED,
        updated_at=WINNER_TIME,
        revision=2,
    )
    repository = _Repository(reads=[confirmed])
    service, unit_of_work = _service(repository)

    result = service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert result.updated_at == WINNER_TIME
    assert repository.confirm_calls == 0
    assert unit_of_work.commits == 0


@pytest.mark.parametrize("schedule", [None, _schedule(account_id="account-b")])
def test_missing_or_cross_account_schedule_returns_non_enumerable_not_found(
    schedule: ScheduleSnapshot | None,
) -> None:
    service, unit_of_work = _service(_Repository(reads=[schedule]))

    with pytest.raises(ScheduleBusinessError) as raised:
        service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert raised.value.code is ScheduleErrorCode.SCHEDULE_NOT_FOUND
    assert raised.value.schedule_id == "schedule-001"
    assert unit_of_work.commits == 0


def test_schedule_without_reminder_returns_stable_conflict() -> None:
    repository = _Repository(reads=[_schedule(reminder=False)])
    service, unit_of_work = _service(repository)

    with pytest.raises(ScheduleBusinessError) as raised:
        service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert raised.value.code is ScheduleErrorCode.REMINDER_NOT_CONFIGURED
    assert repository.confirm_calls == 0
    assert unit_of_work.commits == 0


def test_recurring_schedule_uses_the_same_schedule_aggregate_state() -> None:
    pending = _schedule(kind=ScheduleKind.RECURRING)
    confirmed = replace(
        pending,
        reminder_disposition_state=ReminderDispositionState.CONFIRMED,
        updated_at=NOW,
        revision=2,
    )
    repository = _Repository(reads=[pending], update_result=confirmed)
    service, unit_of_work = _service(repository)

    result = service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert result.disposition_state is ReminderDispositionState.CONFIRMED
    assert repository.confirm_calls == 1
    assert unit_of_work.commits == 1


def test_concurrent_loser_rereads_winner_and_succeeds_without_commit() -> None:
    pending = _schedule()
    winner = replace(
        pending,
        reminder_disposition_state=ReminderDispositionState.CONFIRMED,
        updated_at=WINNER_TIME,
        revision=2,
    )
    repository = _Repository(reads=[pending, winner], update_result=None)
    service, unit_of_work = _service(repository)

    result = service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert result.updated_at == WINNER_TIME
    assert repository.confirm_calls == 1
    assert unit_of_work.commits == 0


@pytest.mark.parametrize(
    ("reread", "expected_code"),
    [
        (None, ScheduleErrorCode.SCHEDULE_NOT_FOUND),
        (_schedule(reminder=False), ScheduleErrorCode.REMINDER_NOT_CONFIGURED),
    ],
)
def test_atomic_miss_is_reclassified_from_current_state(
    reread: ScheduleSnapshot | None,
    expected_code: ScheduleErrorCode,
) -> None:
    pending = _schedule()
    repository = _Repository(reads=[pending, reread], update_result=None)
    service, unit_of_work = _service(repository)

    with pytest.raises(ScheduleBusinessError) as raised:
        service.confirm(account_id="account-a", schedule_id="schedule-001")

    assert raised.value.code is expected_code
    assert repository.confirm_calls == 1
    assert unit_of_work.commits == 0
