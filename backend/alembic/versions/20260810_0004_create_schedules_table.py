"""Replace the empty MVP schedules table with the cloud schedule schema.

Revision ID: 20260810_0004
Revises: 20260810_0003
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "20260810_0004"
down_revision: str | Sequence[str] | None = "20260810_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Replace the legacy table only when it contains no data."""

    if context.is_offline_mode():
        raise RuntimeError(
            "Migration 20260810_0004 requires online mode because it must inspect "
            "legacy schedules data. Run `alembic upgrade head` without `--sql`."
        )

    connection = op.get_bind()
    legacy_row = connection.execute(sa.text("SELECT 1 FROM schedules LIMIT 1")).first()
    if legacy_row is not None:
        raise RuntimeError(
            "Legacy schedules table contains data; migrate or remove it before replacing the table"
        )

    op.drop_index("ix_schedules_system_alarm_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_system_schedule_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_user_status_start_time", table_name="schedules")
    op.drop_table("schedules")

    op.create_table(
        "schedules",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("account_id", sa.String(length=64), nullable=False),
        sa.Column("schedule_type", sa.String(length=16), nullable=False),
        sa.Column(
            "schedule_kind",
            sa.String(length=16),
            server_default=sa.text("'once'"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "is_all_day",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
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
        sa.Column(
            "revision",
            sa.BigInteger(),
            server_default=sa.text("1"),
            nullable=False,
        ),
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
        sa.CheckConstraint("status IN ('active', 'deleted')", name="ck_schedules_status"),
        sa.CheckConstraint("revision >= 1", name="ck_schedules_revision_positive"),
        sa.CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_latitude_range",
        ),
        sa.CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_longitude_range",
        ),
        sa.CheckConstraint(
            "(latitude IS NULL AND longitude IS NULL) "
            "OR (latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_coordinates_pair",
        ),
        sa.CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND is_all_day = false "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_schedule_type_requirements",
        ),
        sa.CheckConstraint(
            "(schedule_kind = 'recurring' AND schedule_type = 'time' "
            "AND recurrence_rule IS NOT NULL) "
            "OR (schedule_kind = 'once' AND recurrence_rule IS NULL)",
            name="ck_schedules_recurrence_requirements",
        ),
        sa.CheckConstraint(
            "is_all_day = false OR (schedule_type = 'time' AND end_time IS NOT NULL)",
            name="ck_schedules_all_day_requirements",
        ),
        sa.CheckConstraint(
            "end_time IS NULL OR (start_time IS NOT NULL AND end_time > start_time)",
            name="ck_schedules_time_range",
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
            "reminder_type IS NULL OR reminder_type <> 'at_time' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NOT NULL "
            "AND reminder_offset_minutes IS NULL)",
            name="ck_schedules_at_time_reminder",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type <> 'before_start' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NOT NULL)",
            name="ck_schedules_before_start_reminder",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type NOT IN "
            "('arrive_location', 'return_to_recorded_location') "
            "OR (reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_location_reminder",
        ),
        sa.CheckConstraint(
            "recurrence_rule IS NULL OR length(trim(recurrence_rule)) > 0",
            name="ck_schedules_recurrence_rule_not_blank",
        ),
        sa.CheckConstraint(
            "(status = 'active' AND deleted_at IS NULL) "
            "OR (status = 'deleted' AND deleted_at IS NOT NULL)",
            name="ck_schedules_deleted_at_consistency",
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], name="fk_schedules_account_id"),
    )
    op.create_index(
        "ix_schedules_account_status_start_time",
        "schedules",
        ["account_id", "status", "start_time"],
    )
    op.create_index(
        "ix_schedules_account_updated_at",
        "schedules",
        ["account_id", "updated_at"],
    )


def downgrade() -> None:
    """Restore the exact MVP schedules schema."""

    op.drop_index("ix_schedules_account_updated_at", table_name="schedules")
    op.drop_index("ix_schedules_account_status_start_time", table_name="schedules")
    op.drop_table("schedules")

    op.create_table(
        "schedules",
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
        sa.CheckConstraint("geofence_armed IN (0, 1)", name="ck_schedules_geofence_armed"),
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
