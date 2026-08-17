"""Read-only account schedule snapshot query boundary."""

from typing import Protocol

from timeflow.business.calendar.contracts import AccountScheduleSnapshot
from timeflow.business.calendar.ports import ScheduleUnitOfWorkFactory


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
            return unit_of_work.schedules.get_account_snapshot(account_id=account_id)


__all__ = [
    "AccountScheduleSnapshot",
    "ScheduleSnapshotQueryService",
    "ScheduleSnapshotReader",
]
