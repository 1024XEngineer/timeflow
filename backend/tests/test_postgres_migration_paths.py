"""Real PostgreSQL tests for destructive migration safety paths."""

import os
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config

from alembic import command
from timeflow.infrastructure.settings import get_settings

BACKEND_ROOT = Path(__file__).parents[1]


def test_legacy_data_blocks_replacement_and_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")

    monkeypatch.setenv("TIMEFLOW_DATABASE_URL", database_url)
    get_settings.cache_clear()
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    engine = sa.create_engine(database_url)

    command.downgrade(config, "20260729_0002")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text(
                    """
                    INSERT INTO schedules (
                        id, user_id, source_mode, schedule_type, status, title,
                        start_time, timezone, geofence_radius_meters,
                        geofence_armed, time_remind_offset_minutes,
                        created_at, updated_at
                    ) VALUES (
                        'legacy-test', 'legacy-user', 'manual', 'time',
                        'scheduled', 'legacy', '2026-08-10T00:00:00Z', 'UTC',
                        100, 0, 0, '2026-08-10T00:00:00Z',
                        '2026-08-10T00:00:00Z'
                    )
                    """
                )
            )

        with pytest.raises(RuntimeError, match="Legacy schedules table contains data"):
            command.upgrade(config, "head")

        with engine.connect() as connection:
            assert (
                connection.scalar(sa.text("SELECT version_num FROM alembic_version"))
                == "20260729_0002"
            )
            assert (
                connection.scalar(sa.text("SELECT title FROM schedules WHERE id = 'legacy-test'"))
                == "legacy"
            )
            assert connection.scalar(sa.text("SELECT to_regclass('public.accounts')")) is None
    finally:
        with engine.begin() as connection:
            connection.execute(sa.text("DELETE FROM schedules WHERE id = 'legacy-test'"))
        command.upgrade(config, "head")
        engine.dispose()
        get_settings.cache_clear()
