"""Application service for syncing a reminder's final confirmed state."""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from timeflow.business.calendar.contracts import (
    ReminderDispositionResult,
    ReminderDispositionState,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleSnapshot,
)
from timeflow.business.calendar.ports import ScheduleUnitOfWorkFactory


class ReminderDispositionConfirmer(Protocol):
    """HTTP-facing boundary for the final reminder confirmation use case."""

    def confirm(
        self,
        *,
        account_id: str,
        schedule_id: str,
    ) -> ReminderDispositionResult: ...


class ReminderDispositionService:
    """Confirm one account-owned schedule reminder exactly once."""

    def __init__(
        self,
        unit_of_work_factory: ScheduleUnitOfWorkFactory,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._unit_of_work_factory = unit_of_work_factory
        self._clock = clock or (lambda: datetime.now(UTC))

    def confirm(
        self,
        *,
        account_id: str,
        schedule_id: str,
    ) -> ReminderDispositionResult:
        """Persist ``confirmed`` once, treating duplicates and race losers as success."""
        with self._unit_of_work_factory() as unit_of_work:
            current = unit_of_work.schedules.get_schedule(
                account_id=account_id,
                schedule_id=schedule_id,
            )
            self._require_confirmable(current, schedule_id=schedule_id)
            assert current is not None

            if current.reminder_disposition_state is ReminderDispositionState.CONFIRMED:
                return _to_result(current)

            confirmed = unit_of_work.schedules.confirm_reminder_disposition(
                account_id=account_id,
                schedule_id=schedule_id,
                confirmed_at=self._clock(),
            )
            if confirmed is not None:
                unit_of_work.commit()
                return _to_result(confirmed)

            reread = unit_of_work.schedules.get_schedule(
                account_id=account_id,
                schedule_id=schedule_id,
            )
            self._require_confirmable(reread, schedule_id=schedule_id)
            assert reread is not None
            if reread.reminder_disposition_state is ReminderDispositionState.CONFIRMED:
                return _to_result(reread)

            raise RuntimeError("Reminder confirmation update did not persist")

    @staticmethod
    def _require_confirmable(
        snapshot: ScheduleSnapshot | None,
        *,
        schedule_id: str,
    ) -> None:
        if snapshot is None:
            raise ScheduleBusinessError(
                code=ScheduleErrorCode.SCHEDULE_NOT_FOUND,
                message="Schedule not found",
                schedule_id=schedule_id,
            )
        if snapshot.reminder_type is None:
            raise ScheduleBusinessError(
                code=ScheduleErrorCode.REMINDER_NOT_CONFIGURED,
                message="Reminder not configured",
                schedule_id=schedule_id,
            )


def _to_result(snapshot: ScheduleSnapshot) -> ReminderDispositionResult:
    state = snapshot.reminder_disposition_state
    if state is not ReminderDispositionState.CONFIRMED:
        raise RuntimeError("Reminder confirmation result is not confirmed")
    return ReminderDispositionResult(
        schedule_id=snapshot.id,
        disposition_state=state,
        updated_at=snapshot.updated_at,
    )


__all__ = ["ReminderDispositionConfirmer", "ReminderDispositionService"]
