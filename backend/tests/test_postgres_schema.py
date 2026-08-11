"""PostgreSQL integration contract for the cloud schedule schema."""

from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine, inspect
from sqlalchemy.engine import Connection

from timeflow.data.models import Account, Schedule, ScheduleOccurrenceOverride

EXPECTED_COLUMNS = {
    "accounts": {
        "id": ("VARCHAR(64)", False),
        "username": ("VARCHAR(255)", False),
        "password_hash": ("VARCHAR(255)", False),
        "created_at": ("TIMESTAMP WITH TIME ZONE", False),
        "updated_at": ("TIMESTAMP WITH TIME ZONE", False),
    },
    "schedules": {
        "id": ("VARCHAR(64)", False),
        "account_id": ("VARCHAR(64)", False),
        "schedule_type": ("VARCHAR(16)", False),
        "schedule_kind": ("VARCHAR(16)", False),
        "title": ("VARCHAR(255)", False),
        "is_all_day": ("BOOLEAN", False),
        "start_time": ("TIMESTAMP WITH TIME ZONE", True),
        "end_time": ("TIMESTAMP WITH TIME ZONE", True),
        "timezone": ("VARCHAR(64)", False),
        "recurrence_rule": ("VARCHAR(512)", True),
        "location_name": ("VARCHAR(255)", True),
        "latitude": ("NUMERIC(9, 6)", True),
        "longitude": ("NUMERIC(9, 6)", True),
        "reminder_type": ("VARCHAR(32)", True),
        "reminder_trigger_at": ("TIMESTAMP WITH TIME ZONE", True),
        "reminder_offset_minutes": ("INTEGER", True),
        "reminder_strength": ("VARCHAR(16)", True),
        "reminder_disposition_state": ("VARCHAR(16)", True),
        "status": ("VARCHAR(16)", False),
        "revision": ("BIGINT", False),
        "created_at": ("TIMESTAMP WITH TIME ZONE", False),
        "updated_at": ("TIMESTAMP WITH TIME ZONE", False),
        "deleted_at": ("TIMESTAMP WITH TIME ZONE", True),
    },
    "schedule_occurrence_overrides": {
        "id": ("VARCHAR(64)", False),
        "schedule_id": ("VARCHAR(64)", False),
        "occurrence_start": ("TIMESTAMP WITH TIME ZONE", False),
        "action": ("VARCHAR(16)", False),
        "replacement_schedule_id": ("VARCHAR(64)", True),
        "created_at": ("TIMESTAMP WITH TIME ZONE", False),
        "updated_at": ("TIMESTAMP WITH TIME ZONE", False),
    },
}

EXPECTED_SCHEDULE_CHECKS = {
    "ck_schedules_all_day_requirements",
    "ck_schedules_at_time_reminder",
    "ck_schedules_before_start_reminder",
    "ck_schedules_coordinates_pair",
    "ck_schedules_deleted_at_consistency",
    "ck_schedules_latitude_range",
    "ck_schedules_location_reminder",
    "ck_schedules_longitude_range",
    "ck_schedules_recurrence_requirements",
    "ck_schedules_recurrence_rule_not_blank",
    "ck_schedules_reminder_disposition_state",
    "ck_schedules_reminder_offset_nonnegative",
    "ck_schedules_reminder_presence",
    "ck_schedules_reminder_strength",
    "ck_schedules_reminder_type",
    "ck_schedules_revision_positive",
    "ck_schedules_schedule_kind",
    "ck_schedules_schedule_type",
    "ck_schedules_schedule_type_requirements",
    "ck_schedules_status",
    "ck_schedules_time_range",
}


def _canonical_type(column_type: sa.types.TypeEngine[object]) -> str:
    """Render reflected types without losing PostgreSQL timezone metadata."""

    if isinstance(column_type, sa.String):
        return f"VARCHAR({column_type.length})"
    if isinstance(column_type, sa.DateTime):
        suffix = " WITH TIME ZONE" if column_type.timezone else ""
        return f"TIMESTAMP{suffix}"
    if isinstance(column_type, sa.Numeric):
        return f"NUMERIC({column_type.precision}, {column_type.scale})"
    if isinstance(column_type, sa.BigInteger):
        return "BIGINT"
    if isinstance(column_type, sa.Integer):
        return "INTEGER"
    if isinstance(column_type, sa.Boolean):
        return "BOOLEAN"
    raise AssertionError(f"Unexpected reflected type: {column_type!r}")


def _account_values(account_id: str = "acct-test") -> dict[str, Any]:
    now = datetime(2026, 8, 10, tzinfo=UTC)
    return {
        "id": account_id,
        "username": f"{account_id}-user",
        "password_hash": "test-hash",
        "created_at": now,
        "updated_at": now,
    }


def _schedule_values(
    schedule_id: str = "sch-test", account_id: str = "acct-test"
) -> dict[str, Any]:
    now = datetime(2026, 8, 10, tzinfo=UTC)
    return {
        "id": schedule_id,
        "account_id": account_id,
        "schedule_type": "time",
        "title": "test schedule",
        "start_time": now,
        "timezone": "Asia/Shanghai",
        "status": "active",
        "created_at": now,
        "updated_at": now,
    }


def test_postgres_has_exact_business_tables_and_head(postgres_engine: Engine) -> None:
    inspector = inspect(postgres_engine)
    assert set(inspector.get_table_names()) == {
        "accounts",
        "alembic_version",
        "schedules",
        "schedule_occurrence_overrides",
    }
    with postgres_engine.connect() as connection:
        revision = connection.scalar(sa.text("SELECT version_num FROM alembic_version"))
    assert revision == "20260810_0005"


def test_postgres_columns_match_document(postgres_engine: Engine) -> None:
    inspector = inspect(postgres_engine)
    for table_name, expected_columns in EXPECTED_COLUMNS.items():
        actual = {
            column["name"]: (_canonical_type(column["type"]), column["nullable"])
            for column in inspector.get_columns(table_name)
        }
        assert actual == expected_columns

    schedules = {column["name"]: column for column in inspector.get_columns("schedules")}
    assert "once" in schedules["schedule_kind"]["default"]
    assert schedules["is_all_day"]["default"] == "false"
    assert schedules["revision"]["default"] == "1"


def test_postgres_keys_checks_and_indexes_match_document(
    postgres_engine: Engine,
) -> None:
    inspector = inspect(postgres_engine)

    account_uniques = {
        constraint["name"]: constraint["column_names"]
        for constraint in inspector.get_unique_constraints("accounts")
    }
    assert account_uniques == {"uq_accounts_username": ["username"]}

    schedule_foreign_keys = {
        key["name"]: (key["constrained_columns"], key["referred_table"])
        for key in inspector.get_foreign_keys("schedules")
    }
    assert schedule_foreign_keys == {"fk_schedules_account_id": (["account_id"], "accounts")}
    assert {
        check["name"] for check in inspector.get_check_constraints("schedules")
    } == EXPECTED_SCHEDULE_CHECKS

    schedule_indexes = {
        index["name"]: index["column_names"]
        for index in inspector.get_indexes("schedules")
        if not index.get("duplicates_constraint")
    }
    assert schedule_indexes == {
        "ix_schedules_account_status_start_time": [
            "account_id",
            "status",
            "start_time",
        ],
        "ix_schedules_account_updated_at": ["account_id", "updated_at"],
    }

    override_foreign_keys = {
        key["name"]: (key["constrained_columns"], key["referred_table"])
        for key in inspector.get_foreign_keys("schedule_occurrence_overrides")
    }
    assert override_foreign_keys == {
        "fk_schedule_occurrence_overrides_replacement_schedule_id": (
            ["replacement_schedule_id"],
            "schedules",
        ),
        "fk_schedule_occurrence_overrides_schedule_id": (
            ["schedule_id"],
            "schedules",
        ),
    }
    override_uniques = {
        constraint["name"]: constraint["column_names"]
        for constraint in inspector.get_unique_constraints("schedule_occurrence_overrides")
    }
    assert override_uniques == {
        "uq_schedule_occurrence_overrides_schedule_occurrence": [
            "schedule_id",
            "occurrence_start",
        ]
    }
    assert {
        check["name"] for check in inspector.get_check_constraints("schedule_occurrence_overrides")
    } == {
        "ck_schedule_occurrence_overrides_action",
        "ck_schedule_occurrence_overrides_replacement",
    }
    override_indexes = {
        index["name"]: index["column_names"]
        for index in inspector.get_indexes("schedule_occurrence_overrides")
        if not index.get("duplicates_constraint")
    }
    assert override_indexes == {}


def test_postgres_applies_schedule_server_defaults(
    postgres_connection: Connection,
) -> None:
    postgres_connection.execute(sa.insert(Account.__table__), _account_values())
    row = postgres_connection.execute(
        sa.insert(Schedule.__table__)
        .values(_schedule_values())
        .returning(
            Schedule.__table__.c.schedule_kind,
            Schedule.__table__.c.is_all_day,
            Schedule.__table__.c.revision,
        )
    ).one()

    assert row._tuple() == ("once", False, 1)


@pytest.mark.parametrize(
    "changes",
    [
        {"account_id": "missing-account"},
        {"schedule_type": "unknown"},
        {"schedule_kind": "recurring", "recurrence_rule": None},
        {"is_all_day": True, "end_time": None},
        {"schedule_type": "location", "start_time": None},
        {"latitude": 31.2304, "longitude": None},
        {"reminder_type": "unknown", "reminder_strength": "high"},
        {"reminder_strength": "high"},
        {"reminder_type": "before_start", "reminder_strength": "high"},
        {"status": "deleted", "deleted_at": None},
    ],
)
def test_postgres_rejects_invalid_schedules(
    postgres_connection: Connection,
    changes: dict[str, Any],
) -> None:
    postgres_connection.execute(sa.insert(Account.__table__), _account_values())
    values = _schedule_values()
    values.update(changes)

    with pytest.raises(sa.exc.IntegrityError):
        with postgres_connection.begin_nested():
            postgres_connection.execute(sa.insert(Schedule.__table__), values)


def test_postgres_enforces_account_and_occurrence_uniqueness(
    postgres_connection: Connection,
) -> None:
    account = _account_values()
    postgres_connection.execute(sa.insert(Account.__table__), account)
    duplicate_account = _account_values("acct-other")
    duplicate_account["username"] = account["username"]
    with pytest.raises(sa.exc.IntegrityError):
        with postgres_connection.begin_nested():
            postgres_connection.execute(sa.insert(Account.__table__), duplicate_account)

    postgres_connection.execute(sa.insert(Schedule.__table__), _schedule_values())
    now = datetime(2026, 8, 10, tzinfo=UTC)
    occurrence = {
        "id": "occ-test",
        "schedule_id": "sch-test",
        "occurrence_start": now,
        "action": "cancel",
        "created_at": now,
        "updated_at": now,
    }
    postgres_connection.execute(sa.insert(ScheduleOccurrenceOverride.__table__), occurrence)
    duplicate_occurrence = occurrence | {"id": "occ-other"}
    with pytest.raises(sa.exc.IntegrityError):
        with postgres_connection.begin_nested():
            postgres_connection.execute(
                sa.insert(ScheduleOccurrenceOverride.__table__),
                duplicate_occurrence,
            )


def test_postgres_enforces_occurrence_action_rules(
    postgres_connection: Connection,
) -> None:
    postgres_connection.execute(sa.insert(Account.__table__), _account_values())
    postgres_connection.execute(sa.insert(Schedule.__table__), _schedule_values())
    now = datetime(2026, 8, 10, tzinfo=UTC)
    invalid_override = {
        "id": "occ-invalid",
        "schedule_id": "sch-test",
        "occurrence_start": now,
        "action": "replace",
        "replacement_schedule_id": None,
        "created_at": now,
        "updated_at": now,
    }

    with pytest.raises(sa.exc.IntegrityError):
        postgres_connection.execute(
            sa.insert(ScheduleOccurrenceOverride.__table__), invalid_override
        )
