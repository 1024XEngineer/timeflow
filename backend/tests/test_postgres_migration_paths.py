"""Real PostgreSQL tests for destructive migration safety paths."""

import os
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config

from alembic import command
from timeflow.infrastructure.settings import get_settings

BACKEND_ROOT = Path(__file__).parents[1]


def _database_url() -> str:
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")
    return database_url


def test_legacy_data_blocks_replacement_and_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = _database_url()

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


def test_schedule_category_migration_backfills_existing_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = _database_url()
    monkeypatch.setenv("TIMEFLOW_DATABASE_URL", database_url)
    get_settings.cache_clear()
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    engine = sa.create_engine(database_url)
    now = "2026-08-17T00:00:00Z"

    command.downgrade(config, "20260810_0005")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text(
                    """
                    INSERT INTO accounts (
                        id, username, password_hash, created_at, updated_at
                    ) VALUES (
                        'category-account', 'category-user', 'test-hash', :now, :now
                    )
                    """
                ),
                {"now": now},
            )
            connection.execute(
                sa.text(
                    """
                    INSERT INTO schedules (
                        id, account_id, schedule_type, title, start_time,
                        timezone, status, created_at, updated_at
                    ) VALUES (
                        'category-schedule', 'category-account', 'time', 'legacy schedule',
                        :now, 'UTC', 'active', :now, :now
                    )
                    """
                ),
                {"now": now},
            )

        command.upgrade(config, "head")

        with engine.connect() as connection:
            assert (
                connection.scalar(
                    sa.text("SELECT category FROM schedules WHERE id = 'category-schedule'")
                )
                == "other"
            )
    finally:
        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(sa.text("DELETE FROM schedules WHERE id = 'category-schedule'"))
            connection.execute(sa.text("DELETE FROM accounts WHERE id = 'category-account'"))
        engine.dispose()
        get_settings.cache_clear()
