"""Create recurring schedule occurrence overrides.

Revision ID: 20260810_0005
Revises: 20260810_0004
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260810_0005"
down_revision: str | Sequence[str] | None = "20260810_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create per-occurrence cancellation and replacement records."""

    op.create_table(
        "schedule_occurrence_overrides",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("schedule_id", sa.String(length=64), nullable=False),
        sa.Column("occurrence_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("replacement_schedule_id", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "action IN ('cancel', 'replace')",
            name="ck_schedule_occurrence_overrides_action",
        ),
        sa.CheckConstraint(
            "(action = 'replace' AND replacement_schedule_id IS NOT NULL) "
            "OR (action = 'cancel' AND replacement_schedule_id IS NULL)",
            name="ck_schedule_occurrence_overrides_replacement",
        ),
        sa.ForeignKeyConstraint(
            ["schedule_id"],
            ["schedules.id"],
            name="fk_schedule_occurrence_overrides_schedule_id",
        ),
        sa.ForeignKeyConstraint(
            ["replacement_schedule_id"],
            ["schedules.id"],
            name="fk_schedule_occurrence_overrides_replacement_schedule_id",
        ),
        sa.UniqueConstraint(
            "schedule_id",
            "occurrence_start",
            name="uq_schedule_occurrence_overrides_schedule_occurrence",
        ),
    )


def downgrade() -> None:
    """Drop occurrence overrides."""

    op.drop_table("schedule_occurrence_overrides")
