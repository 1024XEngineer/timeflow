"""baseline empty schema

Revision ID: 20260721_0001
Revises:
Create Date: 2026-07-21

尚无业务表；首个 ORM 模型落地后用 autogenerate 生成后续迁移。
"""

from collections.abc import Sequence

revision: str = "20260721_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """空基线：仅建立 alembic_version 追踪。"""


def downgrade() -> None:
    """空基线无回滚操作。"""
