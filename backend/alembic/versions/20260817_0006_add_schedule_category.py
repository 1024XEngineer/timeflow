"""Add the independent schedule content category.

Revision ID: 20260817_0006
Revises: 20260810_0005
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260817_0006"
down_revision: str | Sequence[str] | None = "20260810_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Backfill existing schedules as other and constrain future values."""

    op.add_column(
        "schedules",
        sa.Column(
            "category",
            sa.String(length=16),
            server_default=sa.text("'other'"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_schedules_category",
        "schedules",
        "category IN ('work', 'study', 'exercise', 'entertainment', "
        "'social', 'rest', 'personal', 'other')",
    )


def downgrade() -> None:
    """Remove schedule content categories."""

    op.drop_constraint("ck_schedules_category", "schedules", type_="check")
    op.drop_column("schedules", "category")
