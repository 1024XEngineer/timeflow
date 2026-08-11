"""Schema tests for the documented cloud persistence tables."""

from typing import Any

from sqlalchemy import Boolean, DateTime, Numeric, String

from timeflow.data.models import Account, Schedule, ScheduleOccurrenceOverride


def _constraint_names(model: Any) -> set[str]:
    return {
        constraint.name for constraint in model.__table__.constraints if constraint.name is not None
    }


def _index_names(model: Any) -> set[str]:
    return {index.name for index in model.__table__.indexes if index.name is not None}


def test_accounts_table_matches_documented_schema() -> None:
    assert Account.__tablename__ == "accounts"
    assert list(Account.__table__.columns.keys()) == [
        "id",
        "username",
        "password_hash",
        "created_at",
        "updated_at",
    ]
    assert isinstance(Account.__table__.c.id.type, String)
    assert Account.__table__.c.id.type.length == 64
    assert Account.__table__.c.username.type.length == 255
    assert "uq_accounts_username" in _constraint_names(Account)


def test_schedules_table_matches_documented_columns() -> None:
    assert Schedule.__tablename__ == "schedules"
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
    assert isinstance(Schedule.__table__.c.is_all_day.type, Boolean)
    assert isinstance(Schedule.__table__.c.start_time.type, DateTime)
    assert Schedule.__table__.c.start_time.type.timezone is True
    assert isinstance(Schedule.__table__.c.latitude.type, Numeric)
    assert Schedule.__table__.c.latitude.type.precision == 9
    assert Schedule.__table__.c.latitude.type.scale == 6
    assert list(Schedule.__table__.c.account_id.foreign_keys)[0].target_fullname == "accounts.id"
    assert _index_names(Schedule) == {
        "ix_schedules_account_status_start_time",
        "ix_schedules_account_updated_at",
    }


def test_schedules_table_has_documented_business_constraints() -> None:
    assert {
        "fk_schedules_account_id",
        "ck_schedules_schedule_type",
        "ck_schedules_schedule_kind",
        "ck_schedules_status",
        "ck_schedules_revision_positive",
        "ck_schedules_latitude_range",
        "ck_schedules_longitude_range",
        "ck_schedules_coordinates_pair",
        "ck_schedules_schedule_type_requirements",
        "ck_schedules_recurrence_requirements",
        "ck_schedules_all_day_requirements",
        "ck_schedules_time_range",
        "ck_schedules_reminder_type",
        "ck_schedules_reminder_strength",
        "ck_schedules_reminder_disposition_state",
        "ck_schedules_reminder_offset_nonnegative",
        "ck_schedules_reminder_presence",
        "ck_schedules_at_time_reminder",
        "ck_schedules_before_start_reminder",
        "ck_schedules_location_reminder",
        "ck_schedules_recurrence_rule_not_blank",
        "ck_schedules_deleted_at_consistency",
    } <= _constraint_names(Schedule)


def test_occurrence_overrides_table_matches_documented_schema() -> None:
    assert ScheduleOccurrenceOverride.__tablename__ == "schedule_occurrence_overrides"
    assert list(ScheduleOccurrenceOverride.__table__.columns.keys()) == [
        "id",
        "schedule_id",
        "occurrence_start",
        "action",
        "replacement_schedule_id",
        "created_at",
        "updated_at",
    ]
    assert (
        list(ScheduleOccurrenceOverride.__table__.c.schedule_id.foreign_keys)[0].target_fullname
        == "schedules.id"
    )
    assert (
        list(ScheduleOccurrenceOverride.__table__.c.replacement_schedule_id.foreign_keys)[
            0
        ].target_fullname
        == "schedules.id"
    )
    assert {
        "fk_schedule_occurrence_overrides_schedule_id",
        "fk_schedule_occurrence_overrides_replacement_schedule_id",
        "uq_schedule_occurrence_overrides_schedule_occurrence",
        "ck_schedule_occurrence_overrides_action",
        "ck_schedule_occurrence_overrides_replacement",
    } <= _constraint_names(ScheduleOccurrenceOverride)
    assert _index_names(ScheduleOccurrenceOverride) == set()
