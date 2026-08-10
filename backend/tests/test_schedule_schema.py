"""Schema tests for the v3.10 schedule persistence model."""

from typing import cast

from sqlalchemy import Table

from timeflow.data.models import Schedule, ScheduleOccurrenceOverride


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
