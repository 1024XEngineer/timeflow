"""Schedule draft extraction from ASR text."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from timeflow.business.voice import (
    ScheduleDraft,
    ScheduleParseResult,
    ScheduleType,
    StructuredLLMPort,
)

DEFAULT_GEOFENCE_RADIUS_METERS = 100
DEFAULT_TIME_REMIND_OFFSET_MINUTES = 15
DEFAULT_TIMEZONE = "Asia/Shanghai"

SCHEDULE_DRAFT_SYSTEM_PROMPT = """
你是日程结构化抽取器。
只输出符合 JSON Schema 的 JSON。
只提取 title、start_time、end_time、location_name。
相对时间必须按当前时间计算。
start_time 和 end_time 使用 YYYY-MM-DDTHH:mm 格式，例如 2026-07-30T15:00。
只有明确到具体日期或具体时间时才填写 start_time / end_time。
像“周末”“下周”“近期”“有空”“尽快”这类模糊时间一律填 null，不要擅自扩展成日期范围。
无法确定的字段填 null。
title 保持简短，location_name 只写明确地点名。
""".strip()

SCHEDULE_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string"},
        "start_time": {"type": ["string", "null"]},
        "end_time": {"type": ["string", "null"]},
        "location_name": {"type": ["string", "null"]},
    },
    "required": [
        "title",
        "start_time",
        "end_time",
        "location_name",
    ],
}


class ScheduleDraftParseError(ValueError):
    """Raised when the LLM output cannot become a schedule draft."""


class ScheduleDraftParser:
    """Turn ASR text into a schedule draft through a structured LLM call."""

    def __init__(
        self,
        llm_client: StructuredLLMPort,
        current_time_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self._llm_client = llm_client
        self._current_time_provider = current_time_provider or self._default_current_time

    async def parse(self, asr_text: str) -> ScheduleParseResult:
        """Parse ASR text into a frontend-confirmable schedule draft."""
        normalized_text = asr_text.strip()
        if not normalized_text:
            raise ScheduleDraftParseError("ASR text cannot be empty")

        response = await self._llm_client.generate_json(
            self._build_user_prompt(normalized_text),
            schema=SCHEDULE_DRAFT_SCHEMA,
            response_name="timeflow_schedule_draft",
            system_prompt=self._build_system_prompt(self._current_time_provider()),
            temperature=0,
        )
        draft = self._normalize_draft(response.data)
        return ScheduleParseResult(draft=draft, raw_model_text=response.raw_text)

    @staticmethod
    def _default_current_time() -> datetime:
        return datetime.now(ZoneInfo(DEFAULT_TIMEZONE))

    @staticmethod
    def _build_system_prompt(current_time: datetime) -> str:
        if current_time.tzinfo is None:
            current_time = current_time.replace(tzinfo=ZoneInfo(DEFAULT_TIMEZONE))
        return (
            f"{SCHEDULE_DRAFT_SYSTEM_PROMPT}\n"
            f"当前时间：{current_time.strftime('%Y-%m-%dT%H:%M')}\n"
            f"当前时区：{DEFAULT_TIMEZONE}"
        )

    @staticmethod
    def _build_user_prompt(asr_text: str) -> str:
        return f"提取日程：{asr_text}"

    @classmethod
    def _normalize_draft(cls, data: dict[str, Any]) -> ScheduleDraft:
        title = cls._required_string(data.get("title"), "title")
        start_time = cls._optional_string(data.get("start_time"))
        end_time = cls._optional_string(data.get("end_time"))
        location_name = cls._optional_string(data.get("location_name"))
        schedule_type = cls._derive_schedule_type(start_time, end_time, location_name)
        draft = ScheduleDraft(
            schedule_type=schedule_type,
            title=title,
            notes=None,
            start_time=start_time,
            end_time=end_time,
            timezone=DEFAULT_TIMEZONE,
            location_name=location_name,
            location_address=None,
            latitude=None,
            longitude=None,
            geofence_radius_meters=DEFAULT_GEOFENCE_RADIUS_METERS,
            time_remind_offset_minutes=DEFAULT_TIME_REMIND_OFFSET_MINUTES,
            missing_fields=cls._derive_missing_fields(
                schedule_type,
                start_time,
                latitude=None,
                longitude=None,
            ),
            ambiguous_fields=(),
            needs_confirmation=True,
        )
        return draft

    @staticmethod
    def _derive_schedule_type(
        start_time: str | None,
        end_time: str | None,
        location_name: str | None,
    ) -> ScheduleType:
        if start_time is not None or end_time is not None:
            return "time"
        if location_name is not None:
            return "location"
        raise ScheduleDraftParseError("schedule information missing: start_time or location_name")

    @staticmethod
    def _required_string(value: Any, field: str) -> str:
        if isinstance(value, str) and value.strip():
            return value.strip()
        raise ScheduleDraftParseError(f"{field} is required")

    @staticmethod
    def _optional_string(value: Any) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        return stripped or None

    @staticmethod
    def _derive_missing_fields(
        schedule_type: str,
        start_time: str | None,
        latitude: float | None,
        longitude: float | None,
    ) -> tuple[str, ...]:
        missing: list[str] = []
        if schedule_type == "time" and start_time is None:
            missing.append("start_time")
        if schedule_type == "location":
            if latitude is None:
                missing.append("latitude")
            if longitude is None:
                missing.append("longitude")
        return tuple(missing)


__all__ = [
    "DEFAULT_GEOFENCE_RADIUS_METERS",
    "DEFAULT_TIME_REMIND_OFFSET_MINUTES",
    "SCHEDULE_DRAFT_SCHEMA",
    "SCHEDULE_DRAFT_SYSTEM_PROMPT",
    "ScheduleDraftParseError",
    "ScheduleDraftParser",
]
