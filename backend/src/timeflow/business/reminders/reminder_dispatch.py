"""日程进入提醒窗口后,决定写回触发状态所需的逻辑。"""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class TriggeredSchedule:
    """一条进入提醒窗口、需要下发提醒的日程,携带下发消息所需的全部信息。

    `reason` 由调用方(不同触发来源)指定,`ReminderDispatcher` 只管发送和 ack 跟踪,
    不关心命中原因是时间到点还是进出地理围栏。
    """

    schedule_id: str
    user_id: str
    reason: str


class ScheduleDispatchCommandPort(Protocol):
    """business.reminders 声明的写入 Port,由 data 层实现。"""

    def mark_time_triggered(self, schedule_id: str, triggered_at: datetime) -> bool:
        """记录该日程本轮时间提醒已经命中;仅在此前未记录时真正写入,返回是否发生了写入。"""
        ...

    def mark_done(self, schedule_id: str, updated_at: datetime) -> bool:
        """提醒已被客户端确认后,把日程置为 `done`,结束后续监听。

        仅对仍处于 `scheduled` 的日程生效,返回是否发生了写入——已经是 `done`
        或已被删除的日程不应该被这条路径改回去。
        """
        ...
