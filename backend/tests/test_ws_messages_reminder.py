"""提醒下发/系统引用检查/删除消息类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.reminder import (
    ReminderControl,
    ReminderControlAck,
    ScheduleConfirmed,
    ScheduleConfirmedAck,
    SystemAlarmDelete,
    SystemAlarmDeleteAck,
    SystemRefsCheck,
    SystemRefsCheckResult,
    SystemScheduleDelete,
    SystemScheduleDeleteAck,
)


def test_reminder_control_matches_doc_example() -> None:
    message = ReminderControl.model_validate(
        {
            "type": "reminder.control",
            "schedule_id": "schedule_001",
            "reason": "time_window_reached",
            "action": "show",
        }
    )

    assert message.reason == "time_window_reached"


def test_reminder_control_ack_failure_matches_doc_example() -> None:
    ack = ReminderControlAck.model_validate(
        {
            "type": "reminder.control.ack",
            "schedule_id": "schedule_001",
            "ok": False,
            "error": {"code": "REMINDER_DISPLAY_FAILED", "message": "提醒展示失败"},
        }
    )

    assert ack.error is not None
    assert ack.error.code == "REMINDER_DISPLAY_FAILED"


def test_system_refs_check_matches_doc_example() -> None:
    message = SystemRefsCheck.model_validate(
        {
            "type": "system.refs.check",
            "schedule_id": "schedule_001",
            "system_schedule_ref_id": "system_schedule_001",
            "system_alarm_ref_id": "system_alarm_001",
            "reason": "before_reminder_control",
        }
    )

    assert message.reason == "before_reminder_control"


def test_system_refs_check_result_matches_doc_example() -> None:
    result = SystemRefsCheckResult.model_validate(
        {
            "type": "system.refs.check.result",
            "schedule_id": "schedule_001",
            "ok": True,
            "system_schedule_ref_id": "system_schedule_001",
            "system_schedule_exists": False,
            "system_alarm_ref_id": "system_alarm_001",
            "system_alarm_exists": False,
            "checked_at": "2026-07-28T14:45:00+08:00",
        }
    )

    assert result.system_schedule_exists is False
    assert result.system_alarm_exists is False


def test_system_schedule_delete_and_ack_match_doc_example() -> None:
    delete = SystemScheduleDelete.model_validate(
        {
            "type": "system.schedule.delete",
            "schedule_id": "schedule_001",
            "system_schedule_ref_id": "system_schedule_001",
            "reason": "ws_connected_and_time_near",
        }
    )
    ack = SystemScheduleDeleteAck.model_validate(
        {
            "type": "system.schedule.delete.ack",
            "schedule_id": "schedule_001",
            "ok": False,
            "system_schedule_ref_id": "system_schedule_001",
            "error": {
                "code": "SYSTEM_SCHEDULE_DELETE_FAILED",
                "message": "系统日程删除失败",
                "details": {"reason": "not_found"},
            },
        }
    )

    assert delete.system_schedule_ref_id == ack.system_schedule_ref_id
    assert ack.error is not None


def test_system_alarm_delete_and_ack_match_doc_example() -> None:
    delete = SystemAlarmDelete.model_validate(
        {
            "type": "system.alarm.delete",
            "schedule_id": "schedule_001",
            "system_alarm_ref_id": "system_alarm_001",
            "reason": "ws_connected_and_time_near",
        }
    )
    ack = SystemAlarmDeleteAck.model_validate(
        {
            "type": "system.alarm.delete.ack",
            "schedule_id": "schedule_001",
            "ok": True,
            "system_alarm_ref_id": "system_alarm_001",
        }
    )

    assert delete.system_alarm_ref_id == ack.system_alarm_ref_id
    assert ack.ok is True


def test_schedule_confirmed_and_ack_match_doc_example() -> None:
    confirmed = ScheduleConfirmed.model_validate(
        {
            "type": "schedule.confirmed",
            "schedule_id": "schedule_001",
            "confirmed": True,
            "timestamp": "2026-07-28T12:05:00+08:00",
        }
    )
    ack = ScheduleConfirmedAck.model_validate(
        {"type": "schedule.confirmed.ack", "schedule_id": "schedule_001", "ok": True}
    )

    assert confirmed.confirmed is True
    assert ack.ok is True


def test_system_refs_check_missing_schedule_id_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SystemRefsCheck.model_validate({"type": "system.refs.check", "reason": "x"})
