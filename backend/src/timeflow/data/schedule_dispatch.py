"""SQLAlchemy implementation of the reminder dispatch Query/Command ports.

Does not commit; the caller owns the transaction boundary.
"""

from collections.abc import Iterable
from datetime import datetime
from typing import cast

from sqlalchemy import select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from timeflow.business.schedules import ScheduleRecord
from timeflow.data.models import Schedule


class SqlAlchemyScheduleDispatchAdapter:
    """Implements `ScheduleQueryPort` and `ScheduleDispatchCommandPort` against `schedules`."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_due_time_schedules(self) -> Iterable[ScheduleRecord]:
        """Return scheduled, not-yet-time-triggered rows with a non-null start_time."""
        statement = select(Schedule).where(
            Schedule.status == "scheduled",
            Schedule.start_time.is_not(None),
            Schedule.time_triggered_at.is_(None),
        )
        rows = self._session.execute(statement).scalars().all()
        return [_to_record(row) for row in rows]

    def mark_time_triggered(self, schedule_id: str, triggered_at: datetime) -> bool:
        """Record the time-reminder hit; only the first call for a schedule writes."""
        result = cast(
            CursorResult[object],
            self._session.execute(
                update(Schedule)
                .where(Schedule.id == schedule_id, Schedule.time_triggered_at.is_(None))
                .values(time_triggered_at=triggered_at.isoformat())
            ),
        )
        return result.rowcount > 0


def _to_record(row: Schedule) -> ScheduleRecord:
    return ScheduleRecord(
        id=row.id,
        user_id=row.user_id,
        source_mode=row.source_mode,  # type: ignore[arg-type]
        schedule_type=row.schedule_type,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        title=row.title,
        notes=row.notes,
        start_time=row.start_time,
        end_time=row.end_time,
        timezone=row.timezone,
        location_name=row.location_name,
        location_address=row.location_address,
        latitude=row.latitude,
        longitude=row.longitude,
        geofence_radius_meters=row.geofence_radius_meters,
        geofence_armed=bool(row.geofence_armed),
        time_remind_offset_minutes=row.time_remind_offset_minutes,
        time_triggered_at=row.time_triggered_at,
        geo_triggered_at=row.geo_triggered_at,
        system_schedule_ref_id=row.system_schedule_ref_id,
        system_alarm_ref_id=row.system_alarm_ref_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
