"""Tests for SQLAlchemy schedule repository."""

from datetime import UTC, datetime

from timeflow.business.schedules import (
    ScheduleListQuery,
    ScheduleRecord,
    ScheduleService,
    ScheduleUpsertCommand,
)
from timeflow.data.database import Base, build_engine, build_session_factory
from timeflow.data.schedule_repository import SQLAlchemyScheduleRepository


def _repository() -> SQLAlchemyScheduleRepository:
    engine = build_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return SQLAlchemyScheduleRepository(build_session_factory(engine))


def _record(
    schedule_id: str,
    *,
    title: str,
    start_time: str | None,
    created_at: str,
    status: str = "scheduled",
) -> ScheduleRecord:
    return ScheduleRecord(
        id=schedule_id,
        user_id="default_user",
        source_mode="manual",
        schedule_type="time" if start_time is not None else "location",
        status=status,  # type: ignore[arg-type]
        title=title,
        notes=None,
        start_time=start_time,
        end_time=None,
        timezone="Asia/Shanghai",
        location_name="陆家嘴" if start_time is None else None,
        location_address=None,
        latitude=31.2451 if start_time is None else None,
        longitude=121.5067 if start_time is None else None,
        geofence_radius_meters=100,
        geofence_armed=start_time is None,
        time_remind_offset_minutes=15,
        time_triggered_at=None,
        geo_triggered_at=None,
        system_schedule_ref_id=None,
        system_alarm_ref_id=None,
        created_at=created_at,
        updated_at=datetime(2026, 7, 30, 9, 0, tzinfo=UTC).isoformat(),
    )


def test_schedule_repository_saves_and_gets_record() -> None:
    repository = _repository()
    record = _record(
        "schedule_1",
        title="开会",
        start_time="2026-07-30T07:00:00+00:00",
        created_at="2026-07-30T09:00:00+00:00",
    )

    repository.save(record)

    loaded = repository.get("schedule_1", "default_user")
    assert loaded is not None
    assert loaded.id == "schedule_1"
    assert loaded.geofence_armed is False


def test_schedule_repository_lists_start_time_first_and_excludes_deleted() -> None:
    repository = _repository()
    repository.save(
        _record(
            "schedule_location",
            title="取文件",
            start_time=None,
            created_at="2026-07-30T11:00:00+00:00",
        )
    )
    repository.save(
        _record(
            "schedule_time",
            title="开会",
            start_time="2026-07-30T07:00:00+00:00",
            created_at="2026-07-30T10:00:00+00:00",
        )
    )
    repository.save(
        _record(
            "schedule_deleted",
            title="删除项",
            start_time="2026-07-30T06:00:00+00:00",
            created_at="2026-07-30T09:00:00+00:00",
            status="deleted",
        )
    )

    result = repository.list(user_id="default_user", status=None, include_deleted=False)

    assert [record.id for record in result] == ["schedule_time", "schedule_location"]


def test_schedule_repository_finds_overlapping_time_conflicts() -> None:
    repository = _repository()
    repository.save(
        _record(
            "schedule_existing",
            title="已有日程",
            start_time="2026-07-30T07:00:00+00:00",
            created_at="2026-07-30T09:00:00+00:00",
        )
    )

    conflicts = repository.find_time_conflicts(
        user_id="default_user",
        start_time="2026-07-30T07:00:00+00:00",
        end_time=None,
        exclude_schedule_id=None,
    )

    assert len(conflicts) == 1
    assert conflicts[0].schedule_id == "schedule_existing"


def test_schedule_repository_lists_different_offsets_by_absolute_time() -> None:
    repository = _repository()
    schedule_ids = iter(("schedule_earlier", "schedule_later"))
    service = ScheduleService(repository, id_factory=lambda: next(schedule_ids))

    def command(title: str, start_time: str) -> ScheduleUpsertCommand:
        return ScheduleUpsertCommand(
            schedule_id=None,
            source_mode="manual",
            schedule_type="time",
            title=title,
            notes=None,
            start_time=start_time,
            end_time=None,
            timezone=None,
            location_name=None,
            location_address=None,
            latitude=None,
            longitude=None,
            geofence_radius_meters=None,
            geofence_armed=None,
            time_remind_offset_minutes=None,
        )

    service.upsert(command("较早日程", "2026-07-31T00:30:00+14:00"))
    service.upsert(command("较晚日程", "2026-07-30T23:00:00-12:00"))

    result = service.list(ScheduleListQuery(status=None, include_deleted=False))

    assert [schedule.id for schedule in result.schedules] == [
        "schedule_earlier",
        "schedule_later",
    ]
    assert [schedule.start_time for schedule in result.schedules] == [
        "2026-07-30T10:30:00+00:00",
        "2026-07-31T11:00:00+00:00",
    ]
