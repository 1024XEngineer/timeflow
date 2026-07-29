"""Tests for schedule draft parsing."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from timeflow.business.voice import StructuredLLMResult
from timeflow.intelligence.schedule_parser import (
    DEFAULT_GEOFENCE_RADIUS_METERS,
    DEFAULT_TIME_REMIND_OFFSET_MINUTES,
    SCHEDULE_DRAFT_SCHEMA,
    SCHEDULE_DRAFT_SYSTEM_PROMPT,
    ScheduleDraftParseError,
    ScheduleDraftParser,
)


@dataclass
class FakeLLMClient:
    """Capture parser prompts and return a fixed JSON payload."""

    response: dict[str, Any]
    calls: list[dict[str, Any]]

    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.calls = []

    async def generate_json(
        self,
        prompt: str,
        *,
        schema: dict[str, Any],
        response_name: str = "timeflow_response",
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> StructuredLLMResult:
        self.calls.append(
            {
                "prompt": prompt,
                "schema": schema,
                "response_name": response_name,
                "system_prompt": system_prompt,
                "temperature": temperature,
            }
        )
        return StructuredLLMResult(
            data=self.response, raw_text=json.dumps(self.response, ensure_ascii=False)
        )


def test_schedule_parser_builds_structured_draft() -> None:
    """ASR text is converted into a frontend-confirmable schedule draft."""
    current_time = datetime(2026, 7, 29, 10, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    client = FakeLLMClient(
        {
            "title": "开会",
            "start_time": "2026-07-30T15:00",
            "end_time": None,
            "location_name": "陆家嘴",
        }
    )
    parser = ScheduleDraftParser(client, current_time_provider=lambda: current_time)

    result = asyncio.run(parser.parse("明天下午三点在陆家嘴开会"))

    assert result.draft.schedule_type == "time"
    assert result.draft.title == "开会"
    assert result.draft.timezone == "Asia/Shanghai"
    assert result.draft.geofence_radius_meters == DEFAULT_GEOFENCE_RADIUS_METERS
    assert result.draft.time_remind_offset_minutes == DEFAULT_TIME_REMIND_OFFSET_MINUTES
    assert result.draft.missing_fields == ()
    assert result.draft.to_payload()["missing_fields"] == []
    assert SCHEDULE_DRAFT_SYSTEM_PROMPT in client.calls[0]["system_prompt"]
    assert "当前时间：2026-07-29T10:30" in client.calls[0]["system_prompt"]
    assert "当前时区：Asia/Shanghai" in client.calls[0]["system_prompt"]
    assert "模糊时间一律填 null" in client.calls[0]["system_prompt"]
    assert client.calls[0]["schema"] == SCHEDULE_DRAFT_SCHEMA
    assert "明天下午三点在陆家嘴开会" in client.calls[0]["prompt"]


def test_schedule_parser_fills_location_must_have_fields() -> None:
    """Location schedules still expose missing coordinates for frontend completion."""
    client = FakeLLMClient(
        {
            "title": "拜访客户",
            "start_time": None,
            "end_time": None,
            "location_name": "上海中心",
        }
    )
    parser = ScheduleDraftParser(client)

    result = asyncio.run(parser.parse("去上海中心拜访客户"))

    assert result.draft.schedule_type == "location"
    assert result.draft.missing_fields == ()
    assert result.draft.geofence_radius_meters == DEFAULT_GEOFENCE_RADIUS_METERS
    assert result.draft.time_remind_offset_minutes == DEFAULT_TIME_REMIND_OFFSET_MINUTES
    assert result.draft.timezone == "Asia/Shanghai"


def test_schedule_parser_rejects_missing_time_and_location() -> None:
    """A draft cannot be classified when both time and location are missing."""
    client = FakeLLMClient(
        {
            "title": "提醒我处理事情",
            "start_time": None,
            "end_time": None,
            "location_name": None,
        }
    )
    parser = ScheduleDraftParser(client)

    with pytest.raises(ScheduleDraftParseError, match="start_time or location_name"):
        asyncio.run(parser.parse("提醒我处理事情"))


def test_schedule_parser_rejects_empty_text() -> None:
    """Empty ASR output should fail fast before calling the model."""
    parser = ScheduleDraftParser(FakeLLMClient({}))

    with pytest.raises(ScheduleDraftParseError):
        asyncio.run(parser.parse("   "))
