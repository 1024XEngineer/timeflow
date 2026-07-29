"""SQLAlchemy implementation of the schedules Query Port."""

from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from timeflow.business.schedules.time_window_trigger import ScheduleSnapshot
from timeflow.data.models import Schedule


class SqlAlchemyScheduleQueryAdapter:
    """Implements `ScheduleQueryPort` against the real `schedules` table."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_schedules(self) -> Iterable[ScheduleSnapshot]:
        """Return scheduled rows with a non-null start_time as read-only snapshots."""
        statement = select(Schedule).where(
            Schedule.status == "scheduled",
            Schedule.start_time.is_not(None),
        )
        rows = self._session.execute(statement).scalars().all()
        return [_to_snapshot(row) for row in rows]


def _to_snapshot(row: Schedule) -> ScheduleSnapshot:
    start_time: datetime | None = (
        datetime.fromisoformat(row.start_time) if row.start_time is not None else None
    )
    return ScheduleSnapshot(
        schedule_id=row.id,
        status=row.status,
        start_time=start_time,
        time_remind_offset_minutes=row.time_remind_offset_minutes,
    )
