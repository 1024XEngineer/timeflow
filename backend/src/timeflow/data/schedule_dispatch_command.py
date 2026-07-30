"""SQLAlchemy implementation of the schedules dispatch Command Port."""

from datetime import datetime

from sqlalchemy import update
from sqlalchemy.orm import Session

from timeflow.data.models import Schedule


class SqlAlchemyScheduleDispatchCommandAdapter:
    """Implements `ScheduleDispatchCommandPort` against the real `schedules` table.

    Does not commit; the caller owns the transaction boundary.
    """

    def __init__(self, session: Session) -> None:
        self._session = session

    def mark_triggered(self, schedule_id: str, triggered_at: datetime) -> None:
        """Record that this schedule's time reminder has already been processed."""
        self._session.execute(
            update(Schedule)
            .where(Schedule.id == schedule_id)
            .values(time_triggered_at=triggered_at.isoformat())
        )

    def cancel(self, schedule_id: str) -> None:
        """Mark the schedule as deleted."""
        self._session.execute(
            update(Schedule).where(Schedule.id == schedule_id).values(status="deleted")
        )

    def clear_system_schedule_ref(self, schedule_id: str) -> None:
        """Clear the stored system calendar reference after a successful cleanup."""
        self._session.execute(
            update(Schedule)
            .where(Schedule.id == schedule_id)
            .values(system_schedule_ref_id=None)
        )
