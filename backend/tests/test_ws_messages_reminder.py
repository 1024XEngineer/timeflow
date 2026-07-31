"""提醒下发消息类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.reminder import (
    ReminderControl,
    ReminderControlAck,
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
    assert message.action == "show"


def test_reminder_control_ack_success_matches_doc_example() -> None:
    ack = ReminderControlAck.model_validate(
        {
            "type": "reminder.control.ack",
            "schedule_id": "schedule_001",
            "ok": True,
        }
    )

    assert ack.ok is True
    assert ack.error is None


def test_reminder_control_ack_failure_matches_doc_example() -> None:
    ack = ReminderControlAck.model_validate(
        {
            "type": "reminder.control.ack",
            "schedule_id": "schedule_001",
            "ok": False,
            "error": {"code": "REMINDER_DISPLAY_FAILED", "message": "提醒展示失败"},
        }
    )

    assert ack.ok is False
    assert ack.error is not None
    assert ack.error.code == "REMINDER_DISPLAY_FAILED"


def test_reminder_control_missing_schedule_id_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ReminderControl.model_validate(
            {
                "type": "reminder.control",
                "reason": "time_window_reached",
                "action": "show",
            }
        )
