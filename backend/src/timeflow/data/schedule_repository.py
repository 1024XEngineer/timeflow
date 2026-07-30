"""SQLAlchemy implementation of schedule persistence ports."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, case, select
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.schedules import ScheduleConflict, ScheduleRecord, ScheduleStatus
from timeflow.data.models import Schedule


class SQLAlchemyScheduleRepository:
    """Persist schedules through SQLAlchemy sessions."""

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def get(self, schedule_id: str, user_id: str) -> ScheduleRecord | None:
        """Return one schedule for a user."""
        with self._session_factory() as session:
            model = session.get(Schedule, schedule_id)
            if model is None or model.user_id != user_id:
                return None
            return self._to_record(model)

    def save(self, schedule: ScheduleRecord) -> None:
        """Insert or replace one schedule."""
        with self._session_factory() as session:
            session.merge(self._to_model(schedule))
            session.commit()

    def find_time_conflicts(
        self,
        *,
        user_id: str,
        start_time: str,
        end_time: str | None,
        exclude_schedule_id: str | None,
    ) -> Sequence[ScheduleConflict]:
        """Return non-deleted schedules that overlap the requested time window."""
        requested_start = self._parse_time(start_time)
        requested_end = self._parse_time(end_time) if end_time is not None else requested_start

        with self._session_factory() as session:
            statement = (
                select(Schedule)
                .where(Schedule.user_id == user_id)
                .where(Schedule.status != "deleted")
                .where(Schedule.start_time.is_not(None))
            )
            if exclude_schedule_id is not None:
                statement = statement.where(Schedule.id != exclude_schedule_id)

            conflicts: list[ScheduleConflict] = []
            for model in session.scalars(statement):
                if model.start_time is None:
                    continue
                existing_start = self._parse_time(model.start_time)
                existing_end = (
                    self._parse_time(model.end_time)
                    if model.end_time is not None
                    else existing_start
                )
                if existing_start <= requested_end and requested_start <= existing_end:
                    conflicts.append(
                        ScheduleConflict(
                            schedule_id=model.id,
                            title=model.title,
                            start_time=model.start_time,
                            end_time=model.end_time,
                        )
                    )
            return tuple(conflicts)

    def list(
        self,
        *,
        user_id: str,
        status: ScheduleStatus | None,
        include_deleted: bool,
    ) -> Sequence[ScheduleRecord]:
        """Return schedules sorted by start time then creation time."""
        with self._session_factory() as session:
            statement = self._build_list_statement(
                user_id=user_id,
                status=status,
                include_deleted=include_deleted,
            )
            return tuple(self._to_record(model) for model in session.scalars(statement))

    @staticmethod
    def _build_list_statement(
        *,
        user_id: str,
        status: ScheduleStatus | None,
        include_deleted: bool,
    ) -> Select[tuple[Schedule]]:
        statement = select(Schedule).where(Schedule.user_id == user_id)
        if status is not None:
            statement = statement.where(Schedule.status == status)
        elif not include_deleted:
            statement = statement.where(Schedule.status != "deleted")
        return statement.order_by(
            case((Schedule.start_time.is_(None), 1), else_=0),
            Schedule.start_time.asc(),
            Schedule.created_at.desc(),
        )

    @staticmethod
    def _to_record(model: Schedule) -> ScheduleRecord:
        return ScheduleRecord(
            id=model.id,
            user_id=model.user_id,
            source_mode=model.source_mode,  # type: ignore[arg-type]
            schedule_type=model.schedule_type,  # type: ignore[arg-type]
            status=model.status,  # type: ignore[arg-type]
            title=model.title,
            notes=model.notes,
            start_time=model.start_time,
            end_time=model.end_time,
            timezone=model.timezone,
            location_name=model.location_name,
            location_address=model.location_address,
            latitude=model.latitude,
            longitude=model.longitude,
            geofence_radius_meters=model.geofence_radius_meters,
            geofence_armed=bool(model.geofence_armed),
            time_remind_offset_minutes=model.time_remind_offset_minutes,
            time_triggered_at=model.time_triggered_at,
            geo_triggered_at=model.geo_triggered_at,
            system_schedule_ref_id=model.system_schedule_ref_id,
            system_alarm_ref_id=model.system_alarm_ref_id,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )

    @staticmethod
    def _to_model(record: ScheduleRecord) -> Schedule:
        return Schedule(
            id=record.id,
            user_id=record.user_id,
            source_mode=record.source_mode,
            schedule_type=record.schedule_type,
            status=record.status,
            title=record.title,
            notes=record.notes,
            start_time=record.start_time,
            end_time=record.end_time,
            timezone=record.timezone,
            location_name=record.location_name,
            location_address=record.location_address,
            latitude=record.latitude,
            longitude=record.longitude,
            geofence_radius_meters=record.geofence_radius_meters,
            geofence_armed=1 if record.geofence_armed else 0,
            time_remind_offset_minutes=record.time_remind_offset_minutes,
            time_triggered_at=record.time_triggered_at,
            geo_triggered_at=record.geo_triggered_at,
            system_schedule_ref_id=record.system_schedule_ref_id,
            system_alarm_ref_id=record.system_alarm_ref_id,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    @staticmethod
    def _parse_time(value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)


__all__ = ["SQLAlchemyScheduleRepository"]
