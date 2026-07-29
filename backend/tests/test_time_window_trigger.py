"""时间窗口触发判定的单元测试。"""

from collections.abc import Iterable
from datetime import datetime, timedelta

from timeflow.business.schedules.time_window_trigger import (
    ScheduleSnapshot,
    TimeWindowTriggerService,
)


class _StubQueryPort:
    def __init__(self, schedules: list[ScheduleSnapshot]) -> None:
        self._schedules = schedules

    def list_schedules(self) -> Iterable[ScheduleSnapshot]:
        return self._schedules


def test_schedule_at_offset_boundary_enters_window() -> None:
    """now 刚好等于 start_time 减去提前量时,判定命中。"""
    start_time = datetime(2026, 7, 29, 15, 0)
    schedule = ScheduleSnapshot(
        schedule_id="schedule_1",
        status="scheduled",
        start_time=start_time,
        time_remind_offset_minutes=15,
    )
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(now=start_time - timedelta(minutes=15))

    assert result == ["schedule_1"]


def test_schedule_before_its_window_is_skipped() -> None:
    """还没到 start_time 减去提前量的时刻,不应命中。"""
    start_time = datetime(2026, 7, 29, 15, 0)
    schedule = ScheduleSnapshot(
        schedule_id="schedule_1",
        status="scheduled",
        start_time=start_time,
        time_remind_offset_minutes=15,
    )
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(
        now=start_time - timedelta(minutes=16),
    )

    assert result == []


def test_schedule_without_start_time_is_skipped() -> None:
    """纯地点日程没有 start_time,不参与时间维度判定。"""
    schedule = ScheduleSnapshot(
        schedule_id="schedule_2",
        status="scheduled",
        start_time=None,
        time_remind_offset_minutes=15,
    )
    service = TimeWindowTriggerService(_StubQueryPort([schedule]))

    result = service.find_schedules_entering_window(now=datetime(2026, 7, 29, 15, 0))

    assert result == []


def test_done_or_deleted_schedule_is_skipped() -> None:
    """已完成或已删除的日程不再参与判定。"""
    start_time = datetime(2026, 7, 29, 15, 0)
    schedules = [
        ScheduleSnapshot("schedule_3", "done", start_time, 15),
        ScheduleSnapshot("schedule_4", "deleted", start_time, 15),
    ]
    service = TimeWindowTriggerService(_StubQueryPort(schedules))

    result = service.find_schedules_entering_window(now=start_time)

    assert result == []
