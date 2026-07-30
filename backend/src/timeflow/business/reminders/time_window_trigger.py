"""日程时间提醒窗口的判定逻辑。"""

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Protocol

from timeflow.business.schedules import ScheduleRecord


class ScheduleQueryPort(Protocol):
    """business.reminders 对外声明的 Query Port,由 data 层实现。"""

    def list_due_time_schedules(self) -> Iterable[ScheduleRecord]:
        """返回状态为 scheduled、绑定了 start_time 且尚未触发时间提醒的日程。"""
        ...


class TimeWindowTriggerService:
    """判定哪些日程已进入时间提醒窗口。"""

    def __init__(self, query_port: ScheduleQueryPort) -> None:
        self._query_port = query_port

    def find_schedules_entering_window(self, now: datetime) -> list[ScheduleRecord]:
        """返回在 `now` 时刻已进入提醒窗口的日程列表。"""
        return [
            schedule
            for schedule in self._query_port.list_due_time_schedules()
            if _time_window_reached(schedule, now)
        ]


def _time_window_reached(schedule: ScheduleRecord, now: datetime) -> bool:
    # 非 scheduled 状态或没有 start_time(纯地点日程)一律不参与时间维度判定
    if schedule.status != "scheduled" or schedule.start_time is None:
        return False
    start_time = datetime.fromisoformat(schedule.start_time)
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=UTC)
    remind_at = start_time - timedelta(minutes=schedule.time_remind_offset_minutes)
    return now >= remind_at
