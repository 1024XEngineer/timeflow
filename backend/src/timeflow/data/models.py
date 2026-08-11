"""SQLAlchemy models for TimeFlow cloud business data."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from timeflow.data.database import Base


class Account(Base):
    """Authenticated account that owns synchronized schedules."""

    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("username", name="uq_accounts_username"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Schedule(Base):
    """Cloud schedule synchronized for an account."""

    __tablename__ = "schedules"
    __table_args__ = (
        CheckConstraint(
            "schedule_type IN ('time', 'location')",
            name="ck_schedules_schedule_type",
        ),
        CheckConstraint(
            "schedule_kind IN ('once', 'recurring')",
            name="ck_schedules_schedule_kind",
        ),
        CheckConstraint("status IN ('active', 'deleted')", name="ck_schedules_status"),
        CheckConstraint("revision >= 1", name="ck_schedules_revision_positive"),
        CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_latitude_range",
        ),
        CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_longitude_range",
        ),
        CheckConstraint(
            "(latitude IS NULL AND longitude IS NULL) "
            "OR (latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_coordinates_pair",
        ),
        CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND is_all_day = false "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_schedule_type_requirements",
        ),
        CheckConstraint(
            "(schedule_kind = 'recurring' AND schedule_type = 'time' "
            "AND recurrence_rule IS NOT NULL) "
            "OR (schedule_kind = 'once' AND recurrence_rule IS NULL)",
            name="ck_schedules_recurrence_requirements",
        ),
        CheckConstraint(
            "is_all_day = false OR (schedule_type = 'time' AND end_time IS NOT NULL)",
            name="ck_schedules_all_day_requirements",
        ),
        CheckConstraint(
            "end_time IS NULL OR (start_time IS NOT NULL AND end_time > start_time)",
            name="ck_schedules_time_range",
        ),
        CheckConstraint(
            "reminder_type IS NULL OR reminder_type IN "
            "('at_time', 'before_start', 'arrive_location', "
            "'return_to_recorded_location')",
            name="ck_schedules_reminder_type",
        ),
        CheckConstraint(
            "reminder_strength IS NULL OR reminder_strength IN ('low', 'medium', 'high')",
            name="ck_schedules_reminder_strength",
        ),
        CheckConstraint(
            "reminder_disposition_state IS NULL OR reminder_disposition_state = 'confirmed'",
            name="ck_schedules_reminder_disposition_state",
        ),
        CheckConstraint(
            "reminder_offset_minutes IS NULL OR reminder_offset_minutes >= 0",
            name="ck_schedules_reminder_offset_nonnegative",
        ),
        CheckConstraint(
            "(reminder_type IS NULL AND reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NULL AND reminder_strength IS NULL "
            "AND reminder_disposition_state IS NULL) "
            "OR (reminder_type IS NOT NULL AND reminder_strength IS NOT NULL)",
            name="ck_schedules_reminder_presence",
        ),
        CheckConstraint(
            "reminder_type IS NULL OR reminder_type <> 'at_time' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NOT NULL AND reminder_offset_minutes IS NULL)",
            name="ck_schedules_at_time_reminder",
        ),
        CheckConstraint(
            "reminder_type IS NULL OR reminder_type <> 'before_start' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NULL AND reminder_offset_minutes IS NOT NULL)",
            name="ck_schedules_before_start_reminder",
        ),
        CheckConstraint(
            "reminder_type IS NULL OR reminder_type NOT IN "
            "('arrive_location', 'return_to_recorded_location') "
            "OR (reminder_trigger_at IS NULL AND reminder_offset_minutes IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_location_reminder",
        ),
        CheckConstraint(
            "recurrence_rule IS NULL OR length(trim(recurrence_rule)) > 0",
            name="ck_schedules_recurrence_rule_not_blank",
        ),
        CheckConstraint(
            "(status = 'active' AND deleted_at IS NULL) "
            "OR (status = 'deleted' AND deleted_at IS NOT NULL)",
            name="ck_schedules_deleted_at_consistency",
        ),
        Index(
            "ix_schedules_account_status_start_time",
            "account_id",
            "status",
            "start_time",
        ),
        Index("ix_schedules_account_updated_at", "account_id", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("accounts.id", name="fk_schedules_account_id"),
        nullable=False,
    )
    schedule_type: Mapped[str] = mapped_column(String(16), nullable=False)
    schedule_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'once'")
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    is_all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    recurrence_rule: Mapped[str | None] = mapped_column(String(512))
    location_name: Mapped[str | None] = mapped_column(String(255))
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    reminder_type: Mapped[str | None] = mapped_column(String(32))
    reminder_trigger_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reminder_offset_minutes: Mapped[int | None] = mapped_column(Integer)
    reminder_strength: Mapped[str | None] = mapped_column(String(16))
    reminder_disposition_state: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScheduleOccurrenceOverride(Base):
    """A canceled or replaced instance of a recurring schedule."""

    __tablename__ = "schedule_occurrence_overrides"
    __table_args__ = (
        UniqueConstraint(
            "schedule_id",
            "occurrence_start",
            name="uq_schedule_occurrence_overrides_schedule_occurrence",
        ),
        CheckConstraint(
            "action IN ('cancel', 'replace')",
            name="ck_schedule_occurrence_overrides_action",
        ),
        CheckConstraint(
            "(action = 'replace' AND replacement_schedule_id IS NOT NULL) "
            "OR (action = 'cancel' AND replacement_schedule_id IS NULL)",
            name="ck_schedule_occurrence_overrides_replacement",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    schedule_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("schedules.id", name="fk_schedule_occurrence_overrides_schedule_id"),
        nullable=False,
    )
    occurrence_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    replacement_schedule_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey(
            "schedules.id",
            name="fk_schedule_occurrence_overrides_replacement_schedule_id",
        ),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


__all__ = ["Account", "Schedule", "ScheduleOccurrenceOverride"]
