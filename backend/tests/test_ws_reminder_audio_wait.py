"""`ReminderAudioGenerationTracker` 有界等待的单元测试。

覆盖的核心问题:音频生成是后台任务,而地理围栏提醒没有任何固有提前量,
刚创建的日程可能一两秒内就命中围栏。没有有界等待的话提醒会静默降级成纯文本,
而且 `geo_triggered_at` 已经写死,永远不会补发音频。
"""

import asyncio
from dataclasses import dataclass
from typing import Any

from timeflow.business.schedules import ScheduleRecord
from timeflow.infrastructure.websocket.reminder_audio import (
    ReminderAudioGenerationTracker,
    ReminderAudioSender,
)


@dataclass
class _FakeAudio:
    data: bytes
    audio_format: str


class _FakeStorage:
    """内存版音频存储,`write` 之后 `read` 才拿得到。"""

    def __init__(self) -> None:
        self.items: dict[str, _FakeAudio] = {}

    async def read(self, schedule_id: str) -> _FakeAudio | None:
        return self.items.get(schedule_id)


class _RecordingConnections:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.audio_calls: list[str] = []

    async def send(self, device_id: str, message: dict[str, Any]) -> bool:
        del device_id
        self.sent.append(message)
        return True

    async def send_audio(
        self,
        device_id: str,
        start: dict[str, Any],
        payload: bytes,
        end: dict[str, Any],
        *,
        preceding_message: dict[str, Any] | None = None,
    ) -> bool:
        del device_id, payload, end
        if preceding_message is not None:
            self.sent.append(preceding_message)
        self.audio_calls.append(start["schedule_id"])
        return True


def _record(schedule_id: str = "schedule_1") -> ScheduleRecord:
    return ScheduleRecord(
        id=schedule_id,
        user_id="device_1",
        source_mode="manual",
        schedule_type="location",
        status="scheduled",
        title="到公司打卡",
        notes=None,
        start_time=None,
        end_time=None,
        timezone=None,
        location_name="公司",
        location_address=None,
        latitude=31.2451,
        longitude=121.5067,
        geofence_radius_meters=100,
        geofence_armed=True,
        time_remind_offset_minutes=15,
        time_triggered_at=None,
        geo_triggered_at=None,
        system_schedule_ref_id=None,
        system_alarm_ref_id=None,
        created_at="2026-07-28T12:00:00+00:00",
        updated_at="2026-07-28T12:00:00+00:00",
    )


class _SlowGenerationService:
    """模拟真实 TTS:耗时若干秒后才把音频写进存储。"""

    def __init__(self, storage: _FakeStorage, delay: float) -> None:
        self._storage = storage
        self._delay = delay

    async def generate(self, schedule: ScheduleRecord) -> bool:
        await asyncio.sleep(self._delay)
        self._storage.items[schedule.id] = _FakeAudio(data=b"AUDIO", audio_format="wav")
        return True

    async def delete(self, schedule_id: str) -> None:
        self._storage.items.pop(schedule_id, None)


def test_reminder_waits_for_in_flight_audio_and_sends_it() -> None:
    """音频还在生成中时,提醒会等它完成,然后带音频一起下发。"""

    async def scenario() -> None:
        storage = _FakeStorage()
        connections = _RecordingConnections()
        tracker = ReminderAudioGenerationTracker(_SlowGenerationService(storage, delay=0.1))
        sender = ReminderAudioSender(
            connections,  # type: ignore[arg-type]
            storage,  # type: ignore[arg-type]
            generation_tracker=tracker,
            audio_wait_seconds=3.0,
        )

        tracker.submit(_record())  # 生成刚开始,存储里还没有音频
        assert storage.items == {}

        await sender.send_reminder("device_1", "schedule_1", reason="geofence_entered")

        assert connections.audio_calls == ["schedule_1"]  # 等到了音频,走的是音频通道

    asyncio.run(scenario())


def test_reminder_does_not_wait_when_no_generation_is_in_flight() -> None:
    """没有在飞的生成任务时立即返回,不能白等——TTS 配置错误/生成早已失败时
    每条提醒都被拖慢 3 秒是不可接受的。"""

    async def scenario() -> None:
        storage = _FakeStorage()
        connections = _RecordingConnections()
        tracker = ReminderAudioGenerationTracker(None)  # 压根没有生成服务
        sender = ReminderAudioSender(
            connections,  # type: ignore[arg-type]
            storage,  # type: ignore[arg-type]
            generation_tracker=tracker,
            audio_wait_seconds=30.0,  # 故意设很大,证明它根本没等
        )

        loop = asyncio.get_running_loop()
        started = loop.time()
        await sender.send_reminder("device_1", "schedule_1", reason="time_window_reached")
        elapsed = loop.time() - started

        assert elapsed < 1.0, f"不该等待,实际耗时 {elapsed:.2f}s"
        assert connections.audio_calls == []
        assert connections.sent[0]["type"] == "reminder.control"  # 纯文本降级

    asyncio.run(scenario())


def test_reminder_gives_up_waiting_after_timeout_and_sends_text_only() -> None:
    """生成太慢时不能无限拖住提醒,超过上限就退回纯文本。"""

    async def scenario() -> None:
        storage = _FakeStorage()
        connections = _RecordingConnections()
        tracker = ReminderAudioGenerationTracker(_SlowGenerationService(storage, delay=5.0))
        sender = ReminderAudioSender(
            connections,  # type: ignore[arg-type]
            storage,  # type: ignore[arg-type]
            generation_tracker=tracker,
            audio_wait_seconds=0.1,
        )

        tracker.submit(_record())
        await sender.send_reminder("device_1", "schedule_1", reason="geofence_entered")

        assert connections.audio_calls == []
        assert connections.sent[0]["type"] == "reminder.control"

        await tracker.aclose()  # 收尾,避免留下未完成的后台任务

    asyncio.run(scenario())


def test_failed_generation_does_not_block_the_reminder() -> None:
    """生成任务抛异常时,等待要正常结束并退回纯文本,不能把异常传播出去。"""

    class _FailingService:
        async def generate(self, schedule: ScheduleRecord) -> bool:
            raise RuntimeError("tts down")

        async def delete(self, schedule_id: str) -> None:
            return None

    async def scenario() -> None:
        storage = _FakeStorage()
        connections = _RecordingConnections()
        tracker = ReminderAudioGenerationTracker(_FailingService())
        sender = ReminderAudioSender(
            connections,  # type: ignore[arg-type]
            storage,  # type: ignore[arg-type]
            generation_tracker=tracker,
            audio_wait_seconds=3.0,
        )

        tracker.submit(_record())
        await sender.send_reminder("device_1", "schedule_1", reason="geofence_entered")

        assert connections.audio_calls == []
        assert connections.sent[0]["type"] == "reminder.control"

    asyncio.run(scenario())
