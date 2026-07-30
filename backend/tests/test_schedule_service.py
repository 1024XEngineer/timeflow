"""Tests for schedule business use cases."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from timeflow.business.schedules import (
    DEFAULT_GEOFENCE_RADIUS_METERS,
    DEFAULT_TIME_REMIND_OFFSET_MINUTES,
    ScheduleConflict,
    ScheduleListQuery,
    ScheduleNotFoundError,
    ScheduleRecord,
    ScheduleService,
    ScheduleStatus,
    ScheduleUpsertCommand,
    ScheduleValidationError,
)


class MemoryScheduleRepository:
    """Small in-memory repository for business service tests."""

    def __init__(self) -> None:
        self.records: dict[str, ScheduleRecord] = {}

    def get(self, schedule_id: str, user_id: str) -> ScheduleRecord | None:
        record = self.records.get(schedule_id)
        if record is None or record.user_id != user_id:
            return None
        return record

    def save(self, schedule: ScheduleRecord) -> None:
        self.records[schedule.id] = schedule

    def find_time_conflicts(
        self,
        *,
        user_id: str,
        start_time: str,
        end_time: str | None,
        exclude_schedule_id: str | None,
    ) -> Sequence[ScheduleConflict]:
        del end_time
        conflicts: list[ScheduleConflict] = []
        for record in self.records.values():
            if record.id == exclude_schedule_id or record.user_id != user_id:
                continue
            if record.status == "deleted" or record.start_time != start_time:
                continue
            conflicts.append(
                ScheduleConflict(
                    schedule_id=record.id,
                    title=record.title,
                    start_time=record.start_time,
                    end_time=record.end_time,
                )
            )
        return tuple(conflicts)

    def list(
        self,
        *,
        user_id: str,
        status: ScheduleStatus | None,
        include_deleted: bool,
    ) -> Sequence[ScheduleRecord]:
        records = [record for record in self.records.values() if record.user_id == user_id]
        if status is not None:
            records = [record for record in records if record.status == status]
        elif not include_deleted:
            records = [record for record in records if record.status != "deleted"]
        return tuple(records)


def _service(repository: MemoryScheduleRepository) -> ScheduleService:
    return ScheduleService(
        repository,
        id_factory=lambda: "schedule_new",
        now_provider=lambda: datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
    )


def _time_command(**overrides: object) -> ScheduleUpsertCommand:
    values = {
        "schedule_id": None,
        "source_mode": "manual",
        "schedule_type": "time",
        "title": "开会",
        "notes": None,
        "start_time": "2026-07-30T15:00:00+08:00",
        "end_time": None,
        "timezone": "Asia/Shanghai",
        "location_name": None,
        "location_address": None,
        "latitude": None,
        "longitude": None,
        "geofence_radius_meters": None,
        "geofence_armed": None,
        "time_remind_offset_minutes": None,
    }
    values.update(overrides)
    return ScheduleUpsertCommand(**values)  # type: ignore[arg-type]


def test_schedule_service_creates_time_schedule_with_defaults() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)

    result = service.upsert(_time_command())

    saved = repository.records[result.schedule_id]
    assert result.schedule_id == "schedule_new"
    assert result.conflicts == ()
    assert saved.user_id == "default_user"
    assert saved.status == "scheduled"
    assert saved.start_time == "2026-07-30T07:00:00+00:00"
    assert saved.geofence_radius_meters == DEFAULT_GEOFENCE_RADIUS_METERS
    assert saved.geofence_armed is False
    assert saved.time_remind_offset_minutes == DEFAULT_TIME_REMIND_OFFSET_MINUTES


def test_schedule_service_returns_conflicts_without_blocking_creation() -> None:
    repository = MemoryScheduleRepository()
    existing_service = ScheduleService(
        repository,
        id_factory=lambda: "schedule_existing",
        now_provider=lambda: datetime(2026, 7, 30, 8, 0, tzinfo=UTC),
    )
    existing_service.upsert(_time_command(title="已有日程"))

    service = _service(repository)
    result = service.upsert(_time_command(title="新日程"))

    assert result.schedule_id == "schedule_new"
    assert len(result.conflicts) == 1
    assert result.conflicts[0].schedule_id == "schedule_existing"


def test_schedule_service_requires_time_for_time_schedule() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)

    with pytest.raises(ScheduleValidationError) as exc_info:
        service.upsert(_time_command(start_time=None))

    assert exc_info.value.field == "start_time"


def test_schedule_service_normalizes_local_time_with_iana_timezone() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)

    result = service.upsert(
        _time_command(
            start_time="2026-07-31T15:00",
            end_time="2026-07-31T16:00",
            timezone="Asia/Shanghai",
        )
    )

    saved = repository.records[result.schedule_id]
    assert saved.start_time == "2026-07-31T07:00:00+00:00"
    assert saved.end_time == "2026-07-31T08:00:00+00:00"


def test_schedule_service_rejects_malformed_time() -> None:
    service = _service(MemoryScheduleRepository())

    with pytest.raises(ScheduleValidationError) as exc_info:
        service.upsert(_time_command(start_time="tomorrow at three"))

    assert exc_info.value.field == "start_time"


def test_schedule_service_requires_timezone_for_local_time() -> None:
    service = _service(MemoryScheduleRepository())

    with pytest.raises(ScheduleValidationError) as exc_info:
        service.upsert(_time_command(start_time="2026-07-31T15:00", timezone=None))

    assert exc_info.value.field == "timezone"


def test_schedule_service_rejects_end_time_before_start_time() -> None:
    service = _service(MemoryScheduleRepository())

    with pytest.raises(ScheduleValidationError) as exc_info:
        service.upsert(
            _time_command(
                start_time="2026-07-31T15:00:00+08:00",
                end_time="2026-07-31T14:59:00+08:00",
            )
        )

    assert exc_info.value.field == "end_time"


def test_schedule_service_requires_coordinates_for_location_schedule() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)

    with pytest.raises(ScheduleValidationError) as exc_info:
        service.upsert(
            _time_command(
                schedule_type="location",
                start_time=None,
                latitude=None,
                longitude=None,
            )
        )

    assert exc_info.value.field == "schedule_type"


def test_schedule_service_lists_non_deleted_by_default() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)
    service.upsert(_time_command())
    deleted = repository.records["schedule_new"]
    repository.records["schedule_new"] = replace(deleted, status="deleted")

    result = service.list(ScheduleListQuery(status=None, include_deleted=False))

    assert result.schedules == ()


def test_schedule_service_requires_include_deleted_for_deleted_status() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)
    service.upsert(_time_command())
    deleted = repository.records["schedule_new"]
    repository.records["schedule_new"] = replace(deleted, status="deleted")

    result = service.list(ScheduleListQuery(status="deleted", include_deleted=False))

    assert result.schedules == ()


def test_schedule_service_delete_marks_status_and_clears_refs() -> None:
    repository = MemoryScheduleRepository()
    service = _service(repository)
    service.upsert(_time_command())
    created = repository.records["schedule_new"]
    repository.records["schedule_new"] = replace(
        created,
        system_schedule_ref_id="calendar_ref_1",
        system_alarm_ref_id="alarm_ref_1",
    )

    service.delete("schedule_new")

    deleted = repository.records["schedule_new"]
    assert deleted.status == "deleted"
    assert deleted.system_schedule_ref_id is None
    assert deleted.system_alarm_ref_id is None


def test_schedule_service_delete_raises_when_not_found() -> None:
    service = _service(MemoryScheduleRepository())

    with pytest.raises(ScheduleNotFoundError):
        service.delete("schedule_missing")
