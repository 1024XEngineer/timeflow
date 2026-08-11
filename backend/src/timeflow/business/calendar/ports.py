"""Persistence abstractions owned by the schedule business layer."""

from collections.abc import Callable
from datetime import datetime
from types import TracebackType
from typing import Protocol, Self

from timeflow.business.calendar.contracts import (
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
)


class ScheduleRevisionConflictError(RuntimeError):
    """An account-owned schedule no longer has the expected revision."""

    __slots__ = ("actual_revision", "expected_revision", "schedule_id")

    def __init__(
        self,
        *,
        schedule_id: str,
        expected_revision: int,
        actual_revision: int,
    ) -> None:
        super().__init__(
            f"Schedule {schedule_id!r} revision conflict: "
            f"expected {expected_revision}, found {actual_revision}"
        )
        self.schedule_id = schedule_id
        self.expected_revision = expected_revision
        self.actual_revision = actual_revision


class ScheduleRepositoryPort(Protocol):
    """Account-scoped persistence operations required by the application service."""

    def add_schedule(self, snapshot: ScheduleSnapshot) -> ScheduleSnapshot: ...

    def get_schedule(
        self,
        *,
        account_id: str,
        schedule_id: str,
        include_deleted: bool = False,
    ) -> ScheduleSnapshot | None: ...

    def list_schedules(
        self,
        *,
        account_id: str,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]: ...

    def list_schedule_candidates(
        self,
        *,
        account_id: str,
        starts_at_or_after: datetime | None,
        starts_before: datetime | None,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]: ...

    def update_schedule(
        self,
        *,
        snapshot: ScheduleSnapshot,
        expected_revision: int,
    ) -> ScheduleSnapshot | None: ...

    def add_occurrence_override(
        self,
        *,
        account_id: str,
        snapshot: ScheduleOccurrenceOverrideSnapshot,
    ) -> ScheduleOccurrenceOverrideSnapshot | None: ...

    def list_occurrence_overrides(
        self,
        *,
        account_id: str,
        schedule_id: str | None = None,
    ) -> tuple[ScheduleOccurrenceOverrideSnapshot, ...]: ...


class ScheduleUnitOfWork(Protocol):
    """One atomic schedule use-case transaction."""

    schedules: ScheduleRepositoryPort

    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...

    def commit(self) -> None: ...


ScheduleUnitOfWorkFactory = Callable[[], ScheduleUnitOfWork]


__all__ = [
    "ScheduleRepositoryPort",
    "ScheduleRevisionConflictError",
    "ScheduleUnitOfWork",
    "ScheduleUnitOfWorkFactory",
]
