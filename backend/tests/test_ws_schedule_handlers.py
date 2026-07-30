"""Tests for schedule WebSocket handlers."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime

from timeflow.business.schedules import (
    ScheduleConflict,
    ScheduleRecord,
    ScheduleService,
    ScheduleStatus,
    ScheduleUpsertCommand,
)
from timeflow.infrastructure.websocket.handlers.schedules import ScheduleWebSocketHandlers


class MemoryScheduleRepository:
    """Small in-memory repository for handler tests."""

    def __init__(self) -> None:
        self.records: dict[str, ScheduleRecord] = {}

    def get(self, schedule_id: str, user_id: str) -> ScheduleRecord | None:
        record = self.records.get(schedule_id)
        if record is None or record.user_id != user_id:
            return None
        return record

    def save(self, schedule: ScheduleRecord) -> None:
        self.records[schedule.id] = schedule

    def find_time_conflicts(
        self,
        *,
        user_id: str,
        start_time: str,
        end_time: str | None,
        exclude_schedule_id: str | None,
    ) -> Sequence[ScheduleConflict]:
        del user_id, start_time, end_time, exclude_schedule_id
        return ()

    def list(
        self,
        *,
        user_id: str,
        status: ScheduleStatus | None,
        include_deleted: bool,
    ) -> Sequence[ScheduleRecord]:
        del status, include_deleted
        return tuple(record for record in self.records.values() if record.user_id == user_id)


def _handlers() -> ScheduleWebSocketHandlers:
    repository = MemoryScheduleRepository()
    service = ScheduleService(
        repository,
        id_factory=lambda: "schedule_new",
        now_provider=lambda: datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
    )
    return ScheduleWebSocketHandlers(service)


def test_schedule_upsert_handler_returns_contract_result() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_upsert(
            {
                "type": "schedule.upsert.command",
                "request_id": "req_schedule_001",
                "payload": {
                    "schedule_id": None,
                    "source_mode": "voice",
                    "schedule_type": "time",
                    "title": "开会",
                    "notes": None,
                    "start_time": "2026-07-30T15:00:00+08:00",
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
            },
            "device_1",
        )
    )

    assert response == {
        "type": "schedule.upsert.result",
        "request_id": "req_schedule_001",
        "ok": True,
        "payload": {
            "schedule_id": "schedule_new",
            "schedule_type": "time",
            "status": "scheduled",
            "conflicts": [],
            "geofence_armed": True,
        },
    }


def test_schedule_upsert_handler_returns_validation_error() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_upsert(
            {
                "type": "schedule.upsert.command",
                "request_id": "req_schedule_001",
                "payload": {
                    "schedule_id": None,
                    "source_mode": "manual",
                    "schedule_type": "time",
                    "title": "开会",
                    "start_time": None,
                },
            },
            "device_1",
        )
    )

    assert response["type"] == "schedule.upsert.error"
    assert response["ok"] is False
    assert response["error"]["code"] == "VALIDATION_ERROR"
    assert response["error"]["details"]["field"] == "start_time"


def test_schedule_upsert_handler_maps_invalid_time_to_validation_error() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_upsert(
            {
                "type": "schedule.upsert.command",
                "request_id": "req_invalid_time_001",
                "payload": {
                    "schedule_id": None,
                    "source_mode": "manual",
                    "schedule_type": "time",
                    "title": "开会",
                    "start_time": "not-a-time",
                    "timezone": "Asia/Shanghai",
                },
            },
            "device_1",
        )
    )

    assert response["type"] == "schedule.upsert.error"
    assert response["ok"] is False
    assert response["error"]["code"] == "VALIDATION_ERROR"
    assert response["error"]["details"]["field"] == "start_time"


def test_schedule_list_handler_returns_contract_result() -> None:
    repository = MemoryScheduleRepository()
    service = ScheduleService(
        repository,
        id_factory=lambda: "schedule_new",
        now_provider=lambda: datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
    )
    service.upsert(
        ScheduleUpsertCommand(
            schedule_id=None,
            source_mode="manual",
            schedule_type="time",
            title="开会",
            notes=None,
            start_time="2026-07-30T15:00:00+08:00",
            end_time=None,
            timezone="Asia/Shanghai",
            location_name=None,
            location_address=None,
            latitude=None,
            longitude=None,
            geofence_radius_meters=None,
            geofence_armed=None,
            time_remind_offset_minutes=None,
        )
    )
    handlers = ScheduleWebSocketHandlers(service)

    response = asyncio.run(
        handlers.handle_list(
            {
                "type": "schedule.list.query",
                "request_id": "req_schedule_list_001",
                "payload": {"status": None, "include_deleted": False},
            },
            "device_1",
        )
    )

    schedules = response["payload"]["schedules"]
    assert response["type"] == "schedule.list.result"
    assert response["request_id"] == "req_schedule_list_001"
    assert len(schedules) == 1
    assert schedules[0]["id"] == "schedule_new"


def test_schedule_list_handler_returns_validation_error() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_list(
            {
                "type": "schedule.list.query",
                "request_id": "req_schedule_list_001",
                "payload": {"status": "unknown", "include_deleted": False},
            },
            "device_1",
        )
    )

    assert response["type"] == "schedule.list.error"
    assert response["error"]["code"] == "VALIDATION_ERROR"


def test_schedule_deleted_handler_marks_schedule_deleted() -> None:
    handlers = _handlers()
    await_upsert = asyncio.run(
        handlers.handle_upsert(
            {
                "type": "schedule.upsert.command",
                "request_id": "req_schedule_001",
                "payload": {
                    "schedule_id": None,
                    "source_mode": "manual",
                    "schedule_type": "time",
                    "title": "开会",
                    "notes": None,
                    "start_time": "2026-07-30T15:00:00+08:00",
                    "end_time": None,
                    "timezone": "Asia/Shanghai",
                    "location_name": None,
                    "location_address": None,
                    "latitude": None,
                    "longitude": None,
                    "geofence_radius_meters": None,
                    "geofence_armed": None,
                    "time_remind_offset_minutes": None,
                },
            },
            "device_1",
        )
    )
    schedule_id = await_upsert["payload"]["schedule_id"]

    response = asyncio.run(
        handlers.handle_deleted(
            {
                "type": "schedule.deleted",
                "schedule_id": schedule_id,
                "deleted": True,
                "timestamp": "2026-07-30T15:00:00+08:00",
            },
            "device_1",
        )
    )

    assert response == {
        "type": "schedule.deleted.ack",
        "schedule_id": schedule_id,
        "ok": True,
        "error": None,
    }


def test_schedule_deleted_handler_returns_not_found_error() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_deleted(
            {
                "type": "schedule.deleted",
                "schedule_id": "schedule_missing",
                "deleted": True,
                "timestamp": "2026-07-30T15:00:00+08:00",
            },
            "device_1",
        )
    )

    assert response["type"] == "schedule.deleted.ack"
    assert response["schedule_id"] == "schedule_missing"
    assert response["ok"] is False
    assert response["error"]["code"] == "SCHEDULE_DELETE_FAILED"
    assert response["error"]["details"]["reason"] == "schedule_not_found"


def test_schedule_deleted_handler_returns_validation_error() -> None:
    handlers = _handlers()

    response = asyncio.run(
        handlers.handle_deleted(
            {
                "type": "schedule.deleted",
                "schedule_id": "schedule_1",
                # "deleted" 字段缺失,触发 pydantic 校验失败
            },
            "device_1",
        )
    )

    assert response["type"] == "schedule.deleted.ack"
    assert response["schedule_id"] == "schedule_1"
    assert response["ok"] is False
    assert response["error"]["code"] == "VALIDATION_ERROR"
