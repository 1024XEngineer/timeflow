"""Create cloud account and schedule tables alongside the MVP schedules table.

Revision ID: 20260807_0003
Revises: 20260729_0002
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260807_0003"
down_revision: str | Sequence[str] | None = "20260729_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the cloud schema without changing the existing MVP schedules table."""

    op.create_table(
        "accounts",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", name="uq_accounts_username"),
    )

    op.create_table(
        "schedules_cloud",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("account_id", sa.String(length=64), nullable=False),
        sa.Column("schedule_type", sa.String(length=16), nullable=False),
        sa.Column(
            "schedule_kind",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'once'"),
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
        sa.Column(
            "revision",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name="fk_schedules_cloud_account_id",
        ),
        sa.CheckConstraint(
            "schedule_type IN ('time', 'location')",
            name="ck_schedules_cloud_schedule_type",
        ),
        sa.CheckConstraint(
            "schedule_kind IN ('once', 'recurring')",
            name="ck_schedules_cloud_schedule_kind",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'deleted')",
            name="ck_schedules_cloud_status",
        ),
        sa.CheckConstraint(
            "revision >= 1",
            name="ck_schedules_cloud_revision_positive",
        ),
        sa.CheckConstraint(
            "latitude IS NULL OR latitude BETWEEN -90 AND 90",
            name="ck_schedules_cloud_latitude_range",
        ),
        sa.CheckConstraint(
            "longitude IS NULL OR longitude BETWEEN -180 AND 180",
            name="ck_schedules_cloud_longitude_range",
        ),
        sa.CheckConstraint(
            "(latitude IS NULL AND longitude IS NULL) "
            "OR (latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_cloud_coordinates_pair",
        ),
        sa.CheckConstraint(
            "(schedule_type = 'time' AND start_time IS NOT NULL) "
            "OR (schedule_type = 'location' AND is_all_day = false "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_cloud_schedule_type_requirements",
        ),
        sa.CheckConstraint(
            "(schedule_kind = 'recurring' AND schedule_type = 'time' "
            "AND recurrence_rule IS NOT NULL) "
            "OR (schedule_kind = 'once' AND recurrence_rule IS NULL)",
            name="ck_schedules_cloud_recurrence_requirements",
        ),
        sa.CheckConstraint(
            "is_all_day = false OR (schedule_type = 'time' AND end_time IS NOT NULL)",
            name="ck_schedules_cloud_all_day_requirements",
        ),
        sa.CheckConstraint(
            "end_time IS NULL OR (start_time IS NOT NULL AND end_time > start_time)",
            name="ck_schedules_cloud_time_range",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type IN "
            "('at_time', 'before_start', 'arrive_location', 'return_to_recorded_location')",
            name="ck_schedules_cloud_reminder_type",
        ),
        sa.CheckConstraint(
            "reminder_strength IS NULL OR reminder_strength IN ('low', 'medium', 'high')",
            name="ck_schedules_cloud_reminder_strength",
        ),
        sa.CheckConstraint(
            "reminder_disposition_state IS NULL OR reminder_disposition_state = 'confirmed'",
            name="ck_schedules_cloud_reminder_disposition_state",
        ),
        sa.CheckConstraint(
            "reminder_offset_minutes IS NULL OR reminder_offset_minutes >= 0",
            name="ck_schedules_cloud_reminder_offset_nonnegative",
        ),
        sa.CheckConstraint(
            "(reminder_type IS NULL AND reminder_trigger_at IS NULL "
            "AND reminder_offset_minutes IS NULL AND reminder_strength IS NULL "
            "AND reminder_disposition_state IS NULL) "
            "OR (reminder_type IS NOT NULL AND reminder_strength IS NOT NULL)",
            name="ck_schedules_cloud_reminder_presence",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type <> 'at_time' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NOT NULL AND reminder_offset_minutes IS NULL)",
            name="ck_schedules_cloud_at_time_reminder",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type <> 'before_start' "
            "OR (schedule_type = 'time' AND start_time IS NOT NULL "
            "AND reminder_trigger_at IS NULL AND reminder_offset_minutes IS NOT NULL)",
            name="ck_schedules_cloud_before_start_reminder",
        ),
        sa.CheckConstraint(
            "reminder_type IS NULL OR reminder_type NOT IN "
            "('arrive_location', 'return_to_recorded_location') "
            "OR (reminder_trigger_at IS NULL AND reminder_offset_minutes IS NULL "
            "AND latitude IS NOT NULL AND longitude IS NOT NULL)",
            name="ck_schedules_cloud_location_reminder",
        ),
        sa.CheckConstraint(
            "recurrence_rule IS NULL OR length(trim(recurrence_rule)) > 0",
            name="ck_schedules_cloud_recurrence_rule_not_blank",
        ),
        sa.CheckConstraint(
            "(status = 'active' AND deleted_at IS NULL) "
            "OR (status = 'deleted' AND deleted_at IS NOT NULL)",
            name="ck_schedules_cloud_deleted_at_consistency",
        ),
    )
    op.create_index(
        "ix_schedules_cloud_account_status_start_time",
        "schedules_cloud",
        ["account_id", "status", "start_time"],
    )
    op.create_index(
        "ix_schedules_cloud_account_updated_at",
        "schedules_cloud",
        ["account_id", "updated_at"],
    )

    op.create_table(
        "schedule_occurrence_overrides",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("schedule_id", sa.String(length=64), nullable=False),
        sa.Column("occurrence_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("replacement_schedule_id", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["schedule_id"],
            ["schedules_cloud.id"],
            name="fk_schedule_occurrence_overrides_schedule_id",
        ),
        sa.ForeignKeyConstraint(
            ["replacement_schedule_id"],
            ["schedules_cloud.id"],
            name="fk_schedule_occurrence_overrides_replacement_schedule_id",
        ),
        sa.UniqueConstraint(
            "schedule_id",
            "occurrence_start",
            name="uq_schedule_occurrence_overrides_schedule_occurrence",
        ),
        sa.CheckConstraint(
            "action IN ('cancel', 'replace')",
            name="ck_schedule_occurrence_overrides_action",
        ),
        sa.CheckConstraint(
            "(action = 'replace' AND replacement_schedule_id IS NOT NULL) "
            "OR (action = 'cancel' AND replacement_schedule_id IS NULL)",
            name="ck_schedule_occurrence_overrides_replacement",
        ),
    )
    op.create_index(
        "ix_schedule_occurrence_overrides_schedule_id",
        "schedule_occurrence_overrides",
        ["schedule_id"],
    )


def downgrade() -> None:
    """Drop the cloud tables while leaving the MVP schedules table untouched."""

    op.drop_index(
        "ix_schedule_occurrence_overrides_schedule_id",
        table_name="schedule_occurrence_overrides",
    )
    op.drop_table("schedule_occurrence_overrides")
    op.drop_index(
        "ix_schedules_cloud_account_updated_at",
        table_name="schedules_cloud",
    )
    op.drop_index(
        "ix_schedules_cloud_account_status_start_time",
        table_name="schedules_cloud",
    )
    op.drop_table("schedules_cloud")
    op.drop_table("accounts")
