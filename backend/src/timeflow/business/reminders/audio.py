"""提醒文案生成和音频生成业务规则。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from timeflow.business.schedules import ScheduleRecord


@dataclass(frozen=True, slots=True)
class ReminderAudio:
    """Generated audio bytes and the format expected by the client."""

    data: bytes
    audio_format: str


class TextToSpeechPort(Protocol):
    """External capability required to synthesize reminder text."""

    async def synthesize(self, text: str) -> ReminderAudio:
        """Return a complete audio artifact for the supplied text."""


class ReminderAudioStoragePort(Protocol):
    """Persistence capability for one current audio artifact per schedule."""

    async def replace(self, schedule_id: str, audio: ReminderAudio) -> None:
        """Atomically replace the current schedule audio."""

    async def read(self, schedule_id: str) -> ReminderAudio | None:
        """Read the current schedule audio, if it exists."""

    async def delete(self, schedule_id: str) -> None:
        """Delete the current schedule audio."""


class ReminderAudioGenerationPort(Protocol):
    """Use case exposed to adapters after a schedule upsert."""

    async def generate(self, schedule: ScheduleRecord) -> bool:
        """Generate the current reminder audio for a schedule."""


class ReminderTextRenderer:
    """Build deterministic reminder text without an LLM call."""

    def render(self, schedule: ScheduleRecord) -> str:
        title = self._normalize_title(schedule.title)
        if schedule.schedule_type == "location":
            return f"您已到达目标地点附近，别忘了{title}。"

        offset = self._format_offset(schedule.time_remind_offset_minutes)
        return f"您有一个日程，{offset}，{title}。"

    @staticmethod
    def _normalize_title(title: str) -> str:
        return title.strip().rstrip("。！？!?；;，,")

    @classmethod
    def _format_offset(cls, minutes: int) -> str:
        if minutes == 0:
            return "现在"

        days, remaining = divmod(minutes, 24 * 60)
        hours, minute_part = divmod(remaining, 60)
        parts: list[str] = []
        if days:
            parts.append(f"{cls._number_to_chinese(days)}天")
        if hours:
            parts.append(f"{cls._number_to_chinese(hours)}小时")
        if minute_part:
            parts.append(f"{cls._number_to_chinese(minute_part)}分钟")
        return "".join(parts) + "后"

    @staticmethod
    def _number_to_chinese(value: int) -> str:
        digits = "零一二三四五六七八九"
        if value < 10:
            return digits[value]
        if value < 20:
            return "十" if value == 10 else f"十{digits[value - 10]}"
        if value < 100:
            tens, ones = divmod(value, 10)
            return f"{digits[tens]}十{digits[ones] if ones else ''}"
        hundreds, remainder = divmod(value, 100)
        if remainder == 0:
            return f"{digits[hundreds]}百"
        if remainder < 10:
            return f"{digits[hundreds]}百零{digits[remainder]}"
        return f"{digits[hundreds]}百{ReminderTextRenderer._number_to_chinese(remainder)}"


class ReminderAudioGenerationService:
    """Generate and persist the current audio for a schedule asynchronously."""

    def __init__(
        self,
        schedule_getter: Callable[[str, str], ScheduleRecord | None],
        text_to_speech: TextToSpeechPort,
        storage: ReminderAudioStoragePort,
        *,
        user_id: str,
        renderer: ReminderTextRenderer | None = None,
    ) -> None:
        self._schedule_getter = schedule_getter
        self._text_to_speech = text_to_speech
        self._storage = storage
        self._user_id = user_id
        self._renderer = renderer or ReminderTextRenderer()
        self._locks: dict[str, asyncio.Lock] = {}

    async def generate(self, schedule: ScheduleRecord) -> bool:
        """Generate audio and write it only if the schedule is still current."""
        lock = self._locks.setdefault(schedule.id, asyncio.Lock())
        async with lock:
            text = self._renderer.render(schedule)
            audio = await self._text_to_speech.synthesize(text)
            current = self._schedule_getter(schedule.id, self._user_id)
            if current is None or current.updated_at != schedule.updated_at:
                return False
            await self._storage.replace(schedule.id, audio)
            return True

    async def delete(self, schedule_id: str) -> None:
        """Remove the audio belonging to a deleted schedule."""
        await self._storage.delete(schedule_id)


__all__ = [
    "ReminderAudio",
    "ReminderAudioGenerationPort",
    "ReminderAudioGenerationService",
    "ReminderAudioStoragePort",
    "ReminderTextRenderer",
    "TextToSpeechPort",
]
