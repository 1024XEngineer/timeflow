"""Create the cloud accounts table.

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


def upgrade() -> None:
    """Create accounts used to own synchronized schedules."""

    op.create_table(
        "accounts",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", name="uq_accounts_username"),
    )


def downgrade() -> None:
    """Drop accounts."""

    op.drop_table("accounts")
