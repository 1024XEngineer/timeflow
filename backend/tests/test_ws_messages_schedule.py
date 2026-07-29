"""日程创建/查询消息类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.schedule import (
    ScheduleListQuery,
    ScheduleListResult,
    ScheduleUpsertCommand,
    ScheduleUpsertResult,
)


def test_schedule_upsert_command_matches_doc_example() -> None:
    command = ScheduleUpsertCommand.model_validate(
        {
            "type": "schedule.upsert.command",
            "request_id": "req_schedule_001",
            "payload": {
                "schedule_id": None,
                "source_mode": "voice",
                "schedule_type": "time",
                "title": "开会",
                "notes": None,
                "start_time": "2026-07-29T15:00:00+08:00",
                "end_time": None,
                "timezone": "Asia/Shanghai",
                "location_name": "陆家嘴",
                "location_address": None,
                "latitude": 31.2451,
                "longitude": 121.5067,
                "geofence_radius_meters": 100,
                "geofence_armed": True,
                "time_remind_offset_minutes": 15,
            },
        }
    )

    assert command.payload.title == "开会"
    assert command.payload.schedule_id is None


def test_schedule_upsert_result_with_conflicts_matches_doc_example() -> None:
    result = ScheduleUpsertResult.model_validate(
        {
            "type": "schedule.upsert.result",
            "request_id": "req_schedule_001",
            "ok": True,
            "payload": {
                "schedule_id": "schedule_001",
                "schedule_type": "time",
                "status": "scheduled",
                "conflicts": [
                    {
                        "schedule_id": "schedule_older",
                        "title": "已有日程",
                        "start_time": "2026-07-28T15:00:00+08:00",
                        "end_time": "2026-07-28T16:00:00+08:00",
                    }
                ],
                "geofence_armed": True,
            },
        }
    )

    assert len(result.payload.conflicts) == 1
    assert result.payload.conflicts[0].schedule_id == "schedule_older"


def test_schedule_list_query_matches_doc_example() -> None:
    query = ScheduleListQuery.model_validate(
        {
            "type": "schedule.list.query",
            "request_id": "req_schedule_list_001",
            "payload": {"status": None, "include_deleted": False},
        }
    )

    assert query.payload.include_deleted is False


def test_schedule_list_result_matches_doc_example() -> None:
    result = ScheduleListResult.model_validate(
        {
            "type": "schedule.list.result",
            "request_id": "req_schedule_list_001",
            "ok": True,
            "payload": {
                "schedules": [
                    {
                        "id": "schedule_001",
                        "user_id": "default_user",
                        "source_mode": "voice",
                        "schedule_type": "time",
                        "status": "scheduled",
                        "title": "开会",
                        "notes": None,
                        "start_time": "2026-07-29T15:00:00+08:00",
                        "end_time": None,
                        "timezone": "Asia/Shanghai",
                        "location_name": "陆家嘴",
                        "location_address": None,
                        "latitude": 31.2451,
                        "longitude": 121.5067,
                        "geofence_radius_meters": 100,
                        "geofence_armed": True,
                        "time_remind_offset_minutes": 15,
                        "time_triggered_at": None,
                        "geo_triggered_at": None,
                        "system_schedule_ref_id": "system_schedule_001",
                        "system_alarm_ref_id": "system_alarm_001",
                        "created_at": "2026-07-28T12:00:00+08:00",
                        "updated_at": "2026-07-28T12:00:00+08:00",
                    }
                ]
            },
        }
    )

    assert len(result.payload.schedules) == 1
    assert result.payload.schedules[0].id == "schedule_001"


def test_schedule_upsert_command_missing_required_field_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ScheduleUpsertCommand.model_validate(
            {
                "type": "schedule.upsert.command",
                "request_id": "req_schedule_001",
                "payload": {"source_mode": "voice", "schedule_type": "time"},
            }
        )
