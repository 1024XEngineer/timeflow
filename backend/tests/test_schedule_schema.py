"""Schema tests for the v3.10 schedule persistence model."""

from pathlib import Path
from typing import cast

from sqlalchemy import Table

from timeflow.data.models import Schedule, ScheduleOccurrenceOverride

MIGRATION_SOURCE = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20260810_0003_schedule_storage_v3.py"
).read_text(encoding="utf-8")


def test_schedule_table_matches_cloud_snapshot_storage_fields() -> None:
    """The cloud table stores only authoritative schedule and reminder fields."""
    assert list(Schedule.__table__.columns.keys()) == [
        "id",
        "account_id",
        "schedule_type",
        "schedule_kind",
        "title",
        "is_all_day",
        "start_time",
        "end_time",
        "timezone",
        "recurrence_rule",
        "location_name",
        "latitude",
        "longitude",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "reminder_strength",
        "reminder_disposition_state",
        "status",
        "revision",
        "created_at",
        "updated_at",
        "deleted_at",
    ]


def test_schedule_table_keeps_device_runtime_state_out_of_cloud_storage() -> None:
    """Geofence, snooze, and next-trigger state belong only to client SQLite."""
    columns = set(Schedule.__table__.columns.keys())

    assert columns.isdisjoint(
        {
            "geofence_armed",
            "next_trigger_at",
            "snoozed_until",
            "sync_status",
            "time_triggered_at",
            "geo_triggered_at",
        }
    )


def test_occurrence_override_table_matches_v3_contract() -> None:
    """Only exceptional recurring occurrences are persisted."""
    assert list(ScheduleOccurrenceOverride.__table__.columns.keys()) == [
        "id",
        "schedule_id",
        "occurrence_start",
        "action",
        "replacement_schedule_id",
        "created_at",
        "updated_at",
    ]

    occurrence_table = cast(Table, ScheduleOccurrenceOverride.__table__)
    constraint_names = {constraint.name for constraint in occurrence_table.constraints}
    assert "uq_schedule_occurrence_overrides_schedule_occurrence" in constraint_names
    assert "ck_schedule_occurrence_overrides_replacement" in constraint_names


def test_schedule_migration_rejects_overlong_legacy_identifiers() -> None:
    """Legacy ownership identifiers are rejected instead of silently truncated."""
    assert "char_length(id) > 64" in MIGRATION_SOURCE
    assert "char_length(user_id) > 64" in MIGRATION_SOURCE
    assert "left(id, 64)" not in MIGRATION_SOURCE
    assert "left(user_id, 64)" not in MIGRATION_SOURCE


def test_schedule_migration_keeps_completed_legacy_rows_non_active() -> None:
    """A migration round trip must not resurrect a completed legacy schedule."""
    assert MIGRATION_SOURCE.count("status IN ('done', 'deleted')") == 2
    assert "CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'scheduled' END" in MIGRATION_SOURCE
