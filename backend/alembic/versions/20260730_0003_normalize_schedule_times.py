"""Normalize persisted schedule times to UTC.

Revision ID: 20260730_0003
Revises: 20260729_0002
Create Date: 2026-07-30
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa

from alembic import op

revision: str = "20260730_0003"
down_revision: str | Sequence[str] | None = "20260729_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_DEFAULT_TIMEZONE = "Asia/Shanghai"


def _normalize_legacy_time(value: str | None, timezone_name: str | None) -> str | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        try:
            parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name or LEGACY_DEFAULT_TIMEZONE))
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"invalid legacy timezone: {timezone_name}") from exc
    return parsed.astimezone(UTC).isoformat(timespec="seconds")


def upgrade() -> None:
    """Rewrite existing start and end times using one canonical UTC format."""
    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT id, start_time, end_time, timezone FROM schedules")
    ).mappings()
    update_statement = sa.text(
        "UPDATE schedules "
        "SET start_time = :start_time, end_time = :end_time "
        "WHERE id = :schedule_id"
    )
    for row in rows:
        connection.execute(
            update_statement,
            {
                "schedule_id": row["id"],
                "start_time": _normalize_legacy_time(row["start_time"], row["timezone"]),
                "end_time": _normalize_legacy_time(row["end_time"], row["timezone"]),
            },
        )


def downgrade() -> None:
    """UTC normalization is intentionally irreversible."""
