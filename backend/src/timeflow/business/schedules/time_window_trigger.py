"""日程时间提醒窗口的判定逻辑。"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ScheduleSnapshot:
    """判定时间窗口所需的日程只读快照字段。"""

    schedule_id: str
    status: str
    start_time: datetime | None
    time_remind_offset_minutes: int


class ScheduleQueryPort(Protocol):
    """business.schedules 对外声明的 Query Port,由 data 层实现。"""

    def list_schedules(self) -> Iterable[ScheduleSnapshot]:
        """返回需要参与时间窗口判定的日程集合。"""
        ...


class TimeWindowTriggerService:
    """判定哪些日程已进入时间提醒窗口。"""

    def __init__(self, query_port: ScheduleQueryPort) -> None:
        self._query_port = query_port

    def find_schedules_entering_window(self, now: datetime) -> list[str]:
        """返回在 `now` 时刻已进入提醒窗口的 schedule_id 列表。"""
        return [
            schedule.schedule_id
            for schedule in self._query_port.list_schedules()
            if _time_window_reached(schedule, now)
        ]


def _time_window_reached(schedule: ScheduleSnapshot, now: datetime) -> bool:
    # 非 scheduled 状态或没有 start_time(纯地点日程)一律不参与时间维度判定
    if schedule.status != "scheduled" or schedule.start_time is None:
        return False
    remind_at = schedule.start_time - timedelta(minutes=schedule.time_remind_offset_minutes)
    return now >= remind_at
