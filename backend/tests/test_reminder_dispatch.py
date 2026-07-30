"""`TriggeredSchedule` 组装逻辑的单元测试。"""

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule


def test_triggered_schedule_carries_reason() -> None:
    """TriggeredSchedule 携带调用方指定的 schedule_id/user_id/reason。"""
    triggered = TriggeredSchedule(
        schedule_id="schedule_1", user_id="user_1", reason="time_window_reached"
    )

    assert triggered.schedule_id == "schedule_1"
    assert triggered.user_id == "user_1"
    assert triggered.reason == "time_window_reached"
