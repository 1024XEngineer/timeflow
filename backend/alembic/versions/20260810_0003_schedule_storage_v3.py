"""Align schedule storage with the v3.10 architecture.

Revision ID: 20260810_0003
Revises: 20260729_0002
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260810_0003"
down_revision: str | Sequence[str] | None = "20260729_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _create_v3_schedules_table() -> None:
    op.create_table(
        "schedules_v3",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("account_id", sa.String(length=64), nullable=False),
        sa.Column("schedule_type", sa.String(length=16), nullable=False),
        sa.Column(
            "schedule_kind",
            sa.String(length=16),
            nullable=False,
            server_default="once",
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "is_all_day",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("recurrence_rule", sa.String(length=512), nullable=True),
        sa.Column("location_name", sa.String(length=255), nullable=True),
        sa.Column("latitude", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("longitude", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("reminder_type", sa.String(length=32), nullable=True),
        sa.Column("reminder_trigger_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reminder_offset_minutes", sa.Integer(), nullable=True),
        sa.Column("reminder_strength", sa.String(length=16), nullable=True),
        sa.Column("reminder_disposition_state", sa.String(length=16), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "schedule_type IN ('time', 'location')",
            name="ck_schedules_schedule_type",
        ),
        sa.CheckConstraint(
            "schedule_kind IN ('once', 'recurring')",
            name="ck_schedules_schedule_kind",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'deleted')",
            name="ck_schedules_status",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type IN "
            "('at_time', 'before_start', 'arrive_location', "
            "'return_to_recorded_location')",
            name="ck_schedules_reminder_type",
        ),
        sa.CheckConstraint(
            "reminder_strength IS NULL OR reminder_strength IN ('low', 'medium', 'high')",
            name="ck_schedules_reminder_strength",
        ),
        sa.CheckConstraint(
            "reminder_disposition_state IS NULL OR reminder_disposition_state = 'confirmed'",
            name="ck_schedules_reminder_disposition_state",
        ),
        sa.CheckConstraint("revision > 0", name="ck_schedules_revision_positive"),
        sa.CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_latitude_range",
        ),
        sa.CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_longitude_range",
        ),
        sa.CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND start_time IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL AND is_all_day = false)",
            name="ck_schedules_schedule_type_requirements",
        ),
        sa.CheckConstraint(
            "(schedule_kind = 'once' AND recurrence_rule IS NULL) "
            "OR (schedule_kind = 'recurring' AND schedule_type = 'time' "
            "AND recurrence_rule IS NOT NULL)",
            name="ck_schedules_recurrence_requirements",
        ),
        sa.CheckConstraint(
            "is_all_day = false "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL AND end_time IS NOT NULL)",
            name="ck_schedules_all_day_requirements",
        ),
        sa.CheckConstraint(
            "end_time IS NULL OR start_time IS NOT NULL",
            name="ck_schedules_end_requires_start",
        ),
        sa.CheckConstraint(
            "reminder_offset_minutes IS NULL OR reminder_offset_minutes >= 0",
            name="ck_schedules_reminder_offset_nonnegative",
        ),
        sa.CheckConstraint(
            "(reminder_type IS NULL AND reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NULL AND reminder_strength IS NULL "
            "AND reminder_disposition_state IS NULL) "
            "OR (reminder_type IS NOT NULL AND reminder_strength IS NOT NULL)",
            name="ck_schedules_reminder_presence",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL "
            "OR (reminder_type = 'at_time' AND reminder_trigger_at IS NOT NULL "
            "AND reminder_offset_minutes IS NULL) "
            "OR (reminder_type = 'before_start' AND reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NOT NULL) "
            "OR (reminder_type IN ('arrive_location', 'return_to_recorded_location') "
            "AND reminder_trigger_at IS NULL AND reminder_offset_minutes IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_reminder_configuration",
        ),
        sa.CheckConstraint(
            "(status = 'active' AND deleted_at IS NULL) "
            "OR (status = 'deleted' AND deleted_at IS NOT NULL)",
            name="ck_schedules_deleted_at",
        ),
    )


def _create_occurrence_overrides_table() -> None:
    op.create_table(
        "schedule_occurrence_overrides",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column(
            "schedule_id",
            sa.String(length=64),
            sa.ForeignKey("schedules.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("occurrence_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column(
            "replacement_schedule_id",
            sa.String(length=64),
            sa.ForeignKey("schedules.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "action IN ('cancel', 'replace')",
            name="ck_schedule_occurrence_overrides_action",
        ),
        sa.CheckConstraint(
            "(action = 'cancel' AND replacement_schedule_id IS NULL) "
            "OR (action = 'replace' AND replacement_schedule_id IS NOT NULL)",
            name="ck_schedule_occurrence_overrides_replacement",
        ),
        sa.UniqueConstraint(
            "schedule_id",
            "occurrence_start",
            name="uq_schedule_occurrence_overrides_schedule_occurrence",
        ),
    )
    op.create_index(
        "ix_schedule_occurrence_overrides_replacement_schedule_id",
        "schedule_occurrence_overrides",
        ["replacement_schedule_id"],
    )


def upgrade() -> None:
    """Migrate the legacy schedule rows and create occurrence overrides."""
    op.drop_index("ix_schedules_system_alarm_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_system_schedule_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_user_status_start_time", table_name="schedules")

    _create_v3_schedules_table()
    op.create_index(
        "ix_schedules_account_status_start_time",
        "schedules_v3",
        ["account_id", "status", "start_time"],
    )
    op.create_index(
        "ix_schedules_account_revision",
        "schedules_v3",
        ["account_id", "revision"],
    )

    op.execute(
        sa.text(
            """
            INSERT INTO schedules_v3 (
                id, account_id, schedule_type, schedule_kind, title, is_all_day,
                start_time, end_time, timezone, recurrence_rule, location_name,
                latitude, longitude, reminder_type, reminder_trigger_at,
                reminder_offset_minutes, reminder_strength,
                reminder_disposition_state, status, revision, created_at,
                updated_at, deleted_at
            )
            SELECT
                left(id, 64),
                left(user_id, 64),
                schedule_type,
                'once',
                left(title, 255),
                false,
                NULLIF(start_time, '')::timestamptz,
                NULLIF(end_time, '')::timestamptz,
                left(COALESCE(NULLIF(timezone, ''), 'UTC'), 64),
                NULL,
                left(location_name, 255),
                latitude::numeric(9, 6),
                longitude::numeric(9, 6),
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'active' END,
                1,
                COALESCE(NULLIF(created_at, '')::timestamptz, now()),
                COALESCE(NULLIF(updated_at, '')::timestamptz, now()),
                CASE
                    WHEN status = 'deleted'
                    THEN COALESCE(NULLIF(updated_at, '')::timestamptz, now())
                    ELSE NULL
                END
            FROM schedules
            """
        )
    )

    op.drop_table("schedules")
    op.rename_table("schedules_v3", "schedules")
    _create_occurrence_overrides_table()


def downgrade() -> None:
    """Restore the legacy MVP schedule shape while retaining core row data."""
    op.create_table(
        "schedules_v2",
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("source_mode", sa.Text(), nullable=False),
        sa.Column("schedule_type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("start_time", sa.Text(), nullable=True),
        sa.Column("end_time", sa.Text(), nullable=True),
        sa.Column("timezone", sa.Text(), nullable=True),
        sa.Column("location_name", sa.Text(), nullable=True),
        sa.Column("location_address", sa.Text(), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column("geofence_radius_meters", sa.Integer(), nullable=False),
        sa.Column("geofence_armed", sa.Integer(), nullable=False),
        sa.Column("time_remind_offset_minutes", sa.Integer(), nullable=False),
        sa.Column("time_triggered_at", sa.Text(), nullable=True),
        sa.Column("geo_triggered_at", sa.Text(), nullable=True),
        sa.Column("system_schedule_ref_id", sa.Text(), nullable=True),
        sa.Column("system_alarm_ref_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "source_mode IN ('manual', 'voice')",
            name="ck_schedules_source_mode",
        ),
        sa.CheckConstraint(
            "schedule_type IN ('time', 'location')",
            name="ck_schedules_schedule_type",
        ),
        sa.CheckConstraint(
            "status IN ('scheduled', 'done', 'deleted')",
            name="ck_schedules_status",
        ),
        sa.CheckConstraint(
            "geofence_armed IN (0, 1)",
            name="ck_schedules_geofence_armed",
        ),
        sa.CheckConstraint(
            "geofence_radius_meters > 0",
            name="ck_schedules_geofence_radius_positive",
        ),
        sa.CheckConstraint(
            "time_remind_offset_minutes >= 0",
            name="ck_schedules_time_remind_offset_nonnegative",
        ),
        sa.CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_latitude_range",
        ),
        sa.CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_longitude_range",
        ),
        sa.CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND start_time IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_schedule_type_requirements",
        ),
        sa.CheckConstraint(
            "end_time IS NULL OR start_time IS NOT NULL",
            name="ck_schedules_end_requires_start",
        ),
    )

    op.execute(
        sa.text(
            """
            INSERT INTO schedules_v2 (
                id, user_id, source_mode, schedule_type, status, title, notes,
                start_time, end_time, timezone, location_name, location_address,
                latitude, longitude, geofence_radius_meters, geofence_armed,
                time_remind_offset_minutes, time_triggered_at, geo_triggered_at,
                system_schedule_ref_id, system_alarm_ref_id, created_at, updated_at
            )
            SELECT
                id,
                account_id,
                'voice',
                schedule_type,
                CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'scheduled' END,
                title,
                NULL,
                start_time::text,
                end_time::text,
                timezone,
                location_name,
                NULL,
                latitude::double precision,
                longitude::double precision,
                100,
                0,
                0,
                NULL,
                NULL,
                NULL,
                NULL,
                created_at::text,
                updated_at::text
            FROM schedules
            """
        )
    )

    op.drop_index(
        "ix_schedule_occurrence_overrides_replacement_schedule_id",
        table_name="schedule_occurrence_overrides",
    )
    op.drop_table("schedule_occurrence_overrides")
    op.drop_table("schedules")
    op.rename_table("schedules_v2", "schedules")
    op.create_index(
        "ix_schedules_user_status_start_time",
        "schedules",
        ["user_id", "status", "start_time"],
    )
    op.create_index(
        "ix_schedules_system_schedule_ref_id",
        "schedules",
        ["system_schedule_ref_id"],
    )
    op.create_index(
        "ix_schedules_system_alarm_ref_id",
        "schedules",
        ["system_alarm_ref_id"],
    )
