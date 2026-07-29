"""Schema tests for the MVP schedules table."""

from timeflow.data.models import Schedule


def test_schedule_table_has_mvp_columns() -> None:
    """The schedules table exposes the fields required by the MVP design."""

    assert list(Schedule.__table__.columns.keys()) == [
        "id",
        "user_id",
        "source_mode",
        "schedule_type",
        "status",
        "title",
        "notes",
        "start_time",
        "end_time",
        "timezone",
        "location_name",
        "location_address",
        "latitude",
        "longitude",
        "geofence_radius_meters",
        "geofence_armed",
        "time_remind_offset_minutes",
        "time_triggered_at",
        "geo_triggered_at",
        "system_schedule_ref_id",
        "system_alarm_ref_id",
        "created_at",
        "updated_at",
    ]
