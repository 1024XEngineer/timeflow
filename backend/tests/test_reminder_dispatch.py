"""提醒下发判定逻辑的单元测试。"""

from datetime import datetime

from timeflow.business.schedules.reminder_dispatch import (
    NextStep,
    RefsCheckOutcome,
    decide_after_refs_check,
    decide_next_step,
)
from timeflow.business.schedules.time_window_trigger import ScheduleSnapshot


def _snapshot(system_schedule_ref_id: str | None) -> ScheduleSnapshot:
    return ScheduleSnapshot(
        schedule_id="schedule_1",
        user_id="user_1",
        status="scheduled",
        start_time=datetime(2026, 7, 29, 15, 0),
        time_remind_offset_minutes=15,
        system_schedule_ref_id=system_schedule_ref_id,
    )


def test_decide_next_step_needs_refs_check_when_ref_id_present() -> None:
    """绑定了系统日历引用时,需要先发起引用检查。"""
    result = decide_next_step(_snapshot("system_schedule_1"))

    assert result is NextStep.NEEDS_REFS_CHECK


def test_decide_next_step_ready_to_remind_when_no_ref_id() -> None:
    """没有绑定系统日历引用时,可以直接提醒。"""
    result = decide_next_step(_snapshot(None))

    assert result is NextStep.READY_TO_REMIND


def test_decide_after_refs_check_cancels_when_calendar_missing() -> None:
    """系统日历不存在时取消日程,不提醒。"""
    result = decide_after_refs_check(calendar_exists=False)

    assert result is RefsCheckOutcome.CANCEL


def test_decide_after_refs_check_remind_when_calendar_exists() -> None:
    """系统日历还存在时继续提醒。"""
    result = decide_after_refs_check(calendar_exists=True)

    assert result is RefsCheckOutcome.READY_TO_REMIND
