"""时间窗口触发判定的单元测试。"""

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from timeflow.business.reminders.time_window_trigger import TimeWindowTriggerService
from timeflow.business.schedules import ScheduleRecord


class _StubQueryPort:
    def __init__(self, schedules: list[ScheduleRecord]) -> None:
        self._schedules = schedules

    def list_due_time_schedules(self) -> Iterable[ScheduleRecord]:
        return self._schedules


def _record(**overrides: object) -> ScheduleRecord:
    defaults: dict[str, object] = {
        "id": "schedule_1",
        "user_id": "user_1",
        "source_mode": "manual",
        "schedule_type": "time",
        "status": "scheduled",
        "title": "test schedule",
        "notes": None,
        "start_time": "2026-07-29T15:00:00+00:00",
        "end_time": None,
        "timezone": "Asia/Shanghai",
        "location_name": None,
        "location_address": None,
        "latitude": None,
        "longitude": None,
        "geofence_radius_meters": 100,
        "geofence_armed": True,
        "time_remind_offset_minutes": 15,
        "time_triggered_at": None,
        "geo_triggered_at": None,
        "system_schedule_ref_id": None,
        "system_alarm_ref_id": None,
        "created_at": "2026-07-28T12:00:00+00:00",
        "updated_at": "2026-07-28T12:00:00+00:00",
    }
    defaults.update(overrides)
    return ScheduleRecord(**defaults)  # type: ignore[arg-type]


def test_schedule_at_offset_boundary_enters_window() -> None:
    """now 刚好等于 start_time 减去提前量时,判定命中。"""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    schedule = _record(start_time=start_time.isoformat())
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(now=start_time - timedelta(minutes=15))

    assert result == [schedule]


def test_schedule_before_its_window_is_skipped() -> None:
    """还没到 start_time 减去提前量的时刻,不应命中。"""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    schedule = _record(start_time=start_time.isoformat())
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(now=start_time - timedelta(minutes=16))

    assert result == []


def test_schedule_without_start_time_is_skipped() -> None:
    """纯地点日程没有 start_time,不参与时间维度判定。"""
    schedule = _record(
        id="schedule_2",
        schedule_type="location",
        start_time=None,
        latitude=31.0,
        longitude=121.0,
    )
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(now=datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

    assert result == []


def test_done_or_deleted_schedule_is_skipped() -> None:
    """已完成或已删除的日程不再参与判定。"""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    schedules = [
        _record(id="schedule_3", status="done", start_time=start_time.isoformat()),
        _record(id="schedule_4", status="deleted", start_time=start_time.isoformat()),
    ]
    service = TimeWindowTriggerService(_StubQueryPort(schedules))

    result = service.find_schedules_entering_window(now=start_time)

    assert result == []


def test_naive_start_time_is_treated_as_utc() -> None:
    """兼容没有偏移量的历史时间字符串:按 UTC 处理,不因 naive/aware 混用报错。"""
    schedule = _record(start_time="2026-07-29T15:00:00")

    service = TimeWindowTriggerService(_StubQueryPort([schedule]))
    result = service.find_schedules_entering_window(now=datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

    assert result == [schedule]
