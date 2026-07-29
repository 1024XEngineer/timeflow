"""Create the MVP schedules table.

Revision ID: 20260729_0002
Revises: 20260728_0001
Create Date: 2026-07-29
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260729_0002"
down_revision: str | Sequence[str] | None = "20260728_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the schedules table used by the MVP."""

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


def downgrade() -> None:
    """Drop the MVP schedules table."""

    op.drop_index("ix_schedules_system_alarm_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_system_schedule_ref_id", table_name="schedules")
    op.drop_index("ix_schedules_user_status_start_time", table_name="schedules")
    op.drop_table("schedules")
