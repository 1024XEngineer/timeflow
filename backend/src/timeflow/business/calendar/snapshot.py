"""Read-only account schedule snapshot query boundary."""

from dataclasses import dataclass
from typing import Protocol

from timeflow.business.calendar.contracts import (
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
)
from timeflow.business.calendar.ports import ScheduleUnitOfWorkFactory


@dataclass(frozen=True, slots=True)
class AccountScheduleSnapshot:
    """All persisted schedules and occurrence overrides for one account."""

    schedules: tuple[ScheduleSnapshot, ...]
    occurrence_overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...]


class ScheduleSnapshotReader(Protocol):
    """Read an account's complete persisted schedule snapshot."""

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot: ...


class ScheduleSnapshotQueryService:
    """Load one account's schedules and overrides in a single unit of work."""

    def __init__(self, unit_of_work_factory: ScheduleUnitOfWorkFactory) -> None:
        self._unit_of_work_factory = unit_of_work_factory

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot:
        """Return the complete snapshot, including soft-deleted schedules."""
        if not account_id.strip():
            raise ValueError("account_id must be non-empty.")

        with self._unit_of_work_factory() as unit_of_work:
            schedules = unit_of_work.schedules.list_schedules(
                account_id=account_id,
                include_deleted=True,
            )
            occurrence_overrides = unit_of_work.schedules.list_occurrence_overrides(
                account_id=account_id
            )
        return AccountScheduleSnapshot(
            schedules=schedules,
            occurrence_overrides=occurrence_overrides,
        )


__all__ = [
    "AccountScheduleSnapshot",
    "ScheduleSnapshotQueryService",
    "ScheduleSnapshotReader",
]
