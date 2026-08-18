"""Tests for the account-wide schedule snapshot query service."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import TracebackType

import pytest

from timeflow.business.calendar import (
    AccountScheduleSnapshot,
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
    snapshot_result: AccountScheduleSnapshot = AccountScheduleSnapshot((), ())
    calls: list[tuple[str, dict[str, object]]] = field(default_factory=list)

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot:
        self.calls.append(("get_account_snapshot", {"account_id": account_id}))
        return self.snapshot_result


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
        snapshot_result=AccountScheduleSnapshot(
            schedules=(
                _schedule(schedule_id="active-1", status=ScheduleStatus.ACTIVE),
                _schedule(schedule_id="deleted-1", status=ScheduleStatus.DELETED),
            ),
            occurrence_overrides=(_override(),),
        ),
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

    assert result == repository.snapshot_result
    assert factory_calls == 1
    assert (unit_of_work.entered, unit_of_work.exited, unit_of_work.commits) == (1, 1, 0)
    assert repository.calls == [("get_account_snapshot", {"account_id": "account-1"})]


def test_get_account_snapshot_returns_empty_tuples_for_an_account_without_data() -> None:
    repository = _RecordingRepository()
    unit_of_work = _RecordingUnitOfWork(repository)

    result = ScheduleSnapshotQueryService(lambda: unit_of_work).get_account_snapshot(
        account_id="empty-account"
    )

    assert result.schedules == ()
    assert result.occurrence_overrides == ()
    assert repository.calls == [("get_account_snapshot", {"account_id": "empty-account"})]
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
