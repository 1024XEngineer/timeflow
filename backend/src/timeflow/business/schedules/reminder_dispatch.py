"""日程进入提醒窗口后,是否需要系统日历引用检查、以及检查结果如何处理的判定逻辑。"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import Protocol

from timeflow.business.schedules.time_window_trigger import ScheduleSnapshot


class NextStep(Enum):
    """日程进入提醒窗口后,下一步该做什么。"""

    NEEDS_REFS_CHECK = auto()
    READY_TO_REMIND = auto()


class RefsCheckOutcome(Enum):
    """系统日历引用检查结果之后,该取消日程还是继续提醒。"""

    CANCEL = auto()
    READY_TO_REMIND = auto()


@dataclass(frozen=True, slots=True)
class TriggeredSchedule:
    """一条进入提醒窗口的日程,携带后续下发消息所需的全部信息。"""

    schedule_id: str
    user_id: str
    system_schedule_ref_id: str | None
    next_step: NextStep


def decide_next_step(snapshot: ScheduleSnapshot) -> NextStep:
    """日程绑定了系统日历引用时,需要先发起引用检查;没有绑定则可以直接提醒。"""
    if snapshot.system_schedule_ref_id is not None:
        return NextStep.NEEDS_REFS_CHECK
    return NextStep.READY_TO_REMIND


def decide_after_refs_check(calendar_exists: bool) -> RefsCheckOutcome:
    """系统日历不存在则取消日程;存在(或无法确定、按存在处理)则继续提醒。"""
    if not calendar_exists:
        return RefsCheckOutcome.CANCEL
    return RefsCheckOutcome.READY_TO_REMIND


class ScheduleDispatchCommandPort(Protocol):
    """business.schedules 声明的写入 Port,由 data 层实现。"""

    def mark_triggered(self, schedule_id: str, triggered_at: datetime) -> None:
        """记录该日程本轮时间提醒已经处理过,避免重复触发。"""
        ...

    def cancel(self, schedule_id: str) -> None:
        """把日程标记为已取消(用户已经在系统侧删除,不再提醒)。"""
        ...

    def clear_system_schedule_ref(self, schedule_id: str) -> None:
        """系统日历清理成功后,清空日程上记录的系统日历引用。"""
        ...
