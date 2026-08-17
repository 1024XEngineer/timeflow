"""Tests for the account-wide schedule snapshot query service."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import TracebackType

import pytest

from timeflow.business.calendar import (
    OccurrenceOverrideAction,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.business.calendar.snapshot import ScheduleSnapshotQueryService

NOW = datetime(2026, 8, 14, tzinfo=UTC)


@dataclass
class _RecordingRepository:
    schedules_result: tuple[ScheduleSnapshot, ...] = ()
    overrides_result: tuple[ScheduleOccurrenceOverrideSnapshot, ...] = ()
    calls: list[tuple[str, dict[str, object]]] = field(default_factory=list)

    def list_schedules(
        self,
        *,
        account_id: str,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]:
        self.calls.append(
            ("list_schedules", {"account_id": account_id, "include_deleted": include_deleted})
        )
        return self.schedules_result

    def list_occurrence_overrides(
        self,
        *,
        account_id: str,
    ) -> tuple[ScheduleOccurrenceOverrideSnapshot, ...]:
        self.calls.append(("list_occurrence_overrides", {"account_id": account_id}))
        return self.overrides_result


@dataclass
class _RecordingUnitOfWork:
    schedules: _RecordingRepository
    entered: int = 0
    exited: int = 0
    commits: int = 0

    def __enter__(self) -> _RecordingUnitOfWork:
        self.entered += 1
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.exited += 1

    def commit(self) -> None:
        self.commits += 1


def _schedule(*, schedule_id: str, status: ScheduleStatus) -> ScheduleSnapshot:
    return ScheduleSnapshot(
        id=schedule_id,
        account_id="account-1",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title=schedule_id,
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=status,
        revision=1,
        created_at=NOW,
        updated_at=NOW,
        deleted_at=NOW if status is ScheduleStatus.DELETED else None,
    )


def _override() -> ScheduleOccurrenceOverrideSnapshot:
    return ScheduleOccurrenceOverrideSnapshot(
        id="override-1",
        schedule_id="active-1",
        occurrence_start=NOW,
        action=OccurrenceOverrideAction.CANCEL,
        created_at=NOW,
        updated_at=NOW,
    )


def test_get_account_snapshot_reads_active_deleted_schedules_and_overrides_in_one_uow() -> None:
    repository = _RecordingRepository(
        schedules_result=(
            _schedule(schedule_id="active-1", status=ScheduleStatus.ACTIVE),
            _schedule(schedule_id="deleted-1", status=ScheduleStatus.DELETED),
        ),
        overrides_result=(_override(),),
    )
    unit_of_work = _RecordingUnitOfWork(repository)
    factory_calls = 0

    def unit_of_work_factory() -> _RecordingUnitOfWork:
        nonlocal factory_calls
        factory_calls += 1
        return unit_of_work

    result = ScheduleSnapshotQueryService(unit_of_work_factory).get_account_snapshot(
        account_id="account-1"
    )

    assert result.schedules == repository.schedules_result
    assert result.occurrence_overrides == repository.overrides_result
    assert factory_calls == 1
    assert (unit_of_work.entered, unit_of_work.exited, unit_of_work.commits) == (1, 1, 0)
    assert repository.calls == [
        ("list_schedules", {"account_id": "account-1", "include_deleted": True}),
        ("list_occurrence_overrides", {"account_id": "account-1"}),
    ]


def test_get_account_snapshot_returns_empty_tuples_for_an_account_without_data() -> None:
    repository = _RecordingRepository()
    unit_of_work = _RecordingUnitOfWork(repository)

    result = ScheduleSnapshotQueryService(lambda: unit_of_work).get_account_snapshot(
        account_id="empty-account"
    )

    assert result.schedules == ()
    assert result.occurrence_overrides == ()
    assert repository.calls == [
        ("list_schedules", {"account_id": "empty-account", "include_deleted": True}),
        ("list_occurrence_overrides", {"account_id": "empty-account"}),
    ]
    assert unit_of_work.commits == 0


@pytest.mark.parametrize("account_id", ["", "   "])
def test_get_account_snapshot_rejects_empty_account_id_without_opening_a_uow(
    account_id: str,
) -> None:
    factory_calls = 0

    def unit_of_work_factory() -> _RecordingUnitOfWork:
        nonlocal factory_calls
        factory_calls += 1
        return _RecordingUnitOfWork(_RecordingRepository())

    service = ScheduleSnapshotQueryService(unit_of_work_factory)

    with pytest.raises(ValueError, match="account_id"):
        service.get_account_snapshot(account_id=account_id)

    assert factory_calls == 0
