"""位置上报消息类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.location import LocationReport, LocationReportAck


def test_location_report_matches_doc_example() -> None:
    report = LocationReport.model_validate(
        {
            "type": "location.report",
            "schedule_scope": "current",
            "latitude": 31.2451,
            "longitude": 121.5067,
            "accuracy": 18,
            "timestamp": "2026-07-28T12:01:00+08:00",
        }
    )

    assert report.latitude == 31.2451


def test_location_report_ack_success_matches_doc_example() -> None:
    ack = LocationReportAck.model_validate({"type": "location.report.ack", "ok": True})

    assert ack.ok is True
    assert ack.error is None


def test_location_report_ack_failure_matches_doc_example() -> None:
    ack = LocationReportAck.model_validate(
        {
            "type": "location.report.ack",
            "ok": False,
            "error": {
                "code": "INVALID_LOCATION",
                "message": "位置信息不合法",
                "details": {"field": "latitude"},
            },
        }
    )

    assert ack.ok is False
    assert ack.error is not None
    assert ack.error.code == "INVALID_LOCATION"


def test_location_report_missing_latitude_is_rejected() -> None:
    with pytest.raises(ValidationError):
        LocationReport.model_validate(
            {
                "type": "location.report",
                "schedule_scope": "current",
                "longitude": 121.5067,
                "accuracy": 18,
                "timestamp": "2026-07-28T12:01:00+08:00",
            }
        )
