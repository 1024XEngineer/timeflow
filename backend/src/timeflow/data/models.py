"""SQLAlchemy models for TimeFlow business data."""

from sqlalchemy import CheckConstraint, Float, Index, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from timeflow.data.database import Base


class Schedule(Base):
    """Business schedule persisted by the backend."""

    __tablename__ = "schedules"
    __table_args__ = (
        CheckConstraint(
            "source_mode IN ('manual', 'voice')",
            name="ck_schedules_source_mode",
        ),
        CheckConstraint(
            "schedule_type IN ('time', 'location')",
            name="ck_schedules_schedule_type",
        ),
        CheckConstraint(
            "status IN ('scheduled', 'done', 'deleted')",
            name="ck_schedules_status",
        ),
        CheckConstraint(
            "geofence_armed IN (0, 1)",
            name="ck_schedules_geofence_armed",
        ),
        CheckConstraint(
            "geofence_radius_meters > 0",
            name="ck_schedules_geofence_radius_positive",
        ),
        CheckConstraint(
            "time_remind_offset_minutes >= 0",
            name="ck_schedules_time_remind_offset_nonnegative",
        ),
        CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_latitude_range",
        ),
        CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_longitude_range",
        ),
        CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND start_time IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_schedule_type_requirements",
        ),
        CheckConstraint(
            "end_time IS NULL OR start_time IS NOT NULL",
            name="ck_schedules_end_requires_start",
        ),
        Index(
            "ix_schedules_user_status_start_time",
            "user_id",
            "status",
            "start_time",
        ),
        Index("ix_schedules_system_schedule_ref_id", "system_schedule_ref_id"),
        Index("ix_schedules_system_alarm_ref_id", "system_alarm_ref_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    source_mode: Mapped[str] = mapped_column(Text, nullable=False)
    schedule_type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_time: Mapped[str | None] = mapped_column(Text, nullable=True)
    end_time: Mapped[str | None] = mapped_column(Text, nullable=True)
    timezone: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    geofence_radius_meters: Mapped[int] = mapped_column(Integer, nullable=False)
    geofence_armed: Mapped[int] = mapped_column(Integer, nullable=False)
    time_remind_offset_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    time_triggered_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    geo_triggered_at: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_schedule_ref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_alarm_ref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


__all__ = ["Schedule"]
