"""Tests for reminder text generation and current-audio persistence."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

from timeflow.business.reminders import (
    ReminderAudio,
    ReminderAudioGenerationService,
    ReminderTextRenderer,
)
from timeflow.business.schedules import ScheduleRecord
from timeflow.data.reminder_audio_storage import FileReminderAudioStorage


def _schedule(**overrides: object) -> ScheduleRecord:
    values = {
        "id": "schedule_001",
        "user_id": "default_user",
        "source_mode": "manual",
        "schedule_type": "time",
        "status": "scheduled",
        "title": "项目评审会议",
        "notes": None,
        "start_time": "2026-07-31T07:00:00+00:00",
        "end_time": None,
        "timezone": "Asia/Shanghai",
        "location_name": None,
        "location_address": None,
        "latitude": None,
        "longitude": None,
        "geofence_radius_meters": 100,
        "geofence_armed": False,
        "time_remind_offset_minutes": 15,
        "time_triggered_at": None,
        "geo_triggered_at": None,
        "system_schedule_ref_id": None,
        "system_alarm_ref_id": None,
        "created_at": "2026-07-31T06:00:00+00:00",
        "updated_at": "2026-07-31T06:00:00+00:00",
    }
    values.update(overrides)
    return ScheduleRecord(**values)  # type: ignore[arg-type]


def test_renderer_uses_time_offset_without_start_time_calculation() -> None:
    text = ReminderTextRenderer().render(_schedule(time_remind_offset_minutes=75))

    assert text == "您有一个日程，一小时十五分钟后，项目评审会议。"


def test_renderer_uses_fixed_location_template() -> None:
    text = ReminderTextRenderer().render(
        _schedule(
            schedule_type="location",
            start_time=None,
            latitude=31.2,
            longitude=121.5,
        )
    )

    assert text == "您已到达目标地点附近，别忘了项目评审会议。"


def test_generation_discards_audio_for_stale_schedule() -> None:
    original = _schedule()
    current = replace(original, updated_at="2026-07-31T06:01:00+00:00")

    class FakeTTS:
        async def synthesize(self, text: str) -> ReminderAudio:
            assert text.endswith("项目评审会议。")
            return ReminderAudio(data=b"audio", audio_format="wav")

    class FakeStorage:
        def __init__(self) -> None:
            self.replaced = False

        async def replace(self, schedule_id: str, audio: ReminderAudio) -> None:
            del schedule_id, audio
            self.replaced = True

        async def read(self, schedule_id: str) -> ReminderAudio | None:
            del schedule_id
            return None

        async def delete(self, schedule_id: str) -> None:
            del schedule_id

    async def scenario() -> None:
        storage = FakeStorage()
        service = ReminderAudioGenerationService(
            lambda schedule_id, user_id: current
            if schedule_id == current.id and user_id == current.user_id
            else None,
            FakeTTS(),
            storage,
            user_id="default_user",
        )

        generated = await service.generate(original)

        assert generated is False
        assert storage.replaced is False

    asyncio.run(scenario())


def test_file_storage_atomically_replaces_one_schedule_audio(tmp_path: Path) -> None:
    async def scenario() -> None:
        storage = FileReminderAudioStorage(tmp_path)
        await storage.replace(
            "schedule_001",
            ReminderAudio(data=b"RIFFold0WAVE", audio_format="wav"),
        )
        await storage.replace(
            "schedule_001",
            ReminderAudio(data=b"RIFFnew0WAVE", audio_format="wav"),
        )

        audio = await storage.read("schedule_001")

        assert audio is not None
        assert audio.data == b"RIFFnew0WAVE"
        assert audio.audio_format == "wav"
        assert [path.name for path in tmp_path.iterdir()] == ["schedule_001.wav"]

    asyncio.run(scenario())


def test_file_storage_rejects_platform_path_separators(tmp_path: Path) -> None:
    storage = FileReminderAudioStorage(tmp_path)

    for schedule_id in ("schedule/001", "schedule\\001"):
        try:
            storage._path_for(schedule_id, "wav")
        except ValueError as error:
            assert str(error) == "invalid schedule ID for reminder audio path"
        else:
            raise AssertionError("path separators must not be accepted in schedule IDs")
