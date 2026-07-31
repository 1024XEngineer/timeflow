"""Server-initiated reminder control and audio delivery."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from uuid import uuid4

from timeflow.business.reminders import ReminderAudioGenerationPort, ReminderAudioStoragePort
from timeflow.business.schedules import ScheduleRecord
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.messages.reminder import (
    ReminderAudioEnd,
    ReminderAudioStart,
    ReminderControl,
)

DEFAULT_AUDIO_WAIT_SECONDS = 3.0

logger = logging.getLogger(__name__)


class ReminderAudioGenerationTracker:
    """跟踪在飞的 TTS 生成任务,让即将下发的提醒可以短暂等待它的音频。

    音频生成是 `schedule.upsert` 之后的后台任务(实测约 1 秒),而地理围栏提醒
    没有任何固有提前量——用户可能在创建日程后一两秒内就走进围栏。没有这层跟踪,
    提醒会静默降级成纯文本,而且因为 `geo_triggered_at` 在下发前就已写死,
    这条提醒永远拿不到语音,不会补发。

    `wait_for()` 在没有在飞任务时**立即返回**,所以 TTS 配置错误、生成早已失败、
    或音频本来就已经生成好的情况下,提醒不会被白白拖慢。
    """

    def __init__(self, service: ReminderAudioGenerationPort | None = None) -> None:
        self._service = service
        self._tasks: dict[str, asyncio.Task[bool]] = {}

    def submit(self, schedule: ScheduleRecord) -> None:
        """为一条刚创建/更新的日程启动后台音频生成,替换掉同一日程尚未完成的旧任务。"""
        if self._service is None:
            return
        previous = self._tasks.get(schedule.id)
        if previous is not None and not previous.done():
            previous.cancel()
        task = asyncio.create_task(
            self._service.generate(schedule),
            name=f"tts-schedule-{schedule.id}",
        )
        self._tasks[schedule.id] = task
        task.add_done_callback(self._make_done_callback(schedule.id))

    async def wait_for(self, schedule_id: str, timeout: float) -> None:
        """如果这条日程的音频正在生成,最多等 `timeout` 秒;没有在飞任务则立即返回。"""
        task = self._tasks.get(schedule_id)
        if task is None or task.done():
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout)
        except TimeoutError:
            logger.info(
                "reminder audio still generating, sending without audio",
                extra={"schedule_id": schedule_id},
            )
        except asyncio.CancelledError:
            # `CancelledError` 是 BaseException,接不住的话会一路冲出 send_reminder 和
            # dispatch,而这时触发时间戳已经写死,这条提醒就彻底丢了。
            # 内层生成任务被取消(日程被更新/删除)只是"没有音频",继续把提醒发出去;
            # 如果是调用方自己被取消(应用关闭),必须原样向上传播,不能吞掉。
            if not task.cancelled():
                raise
        except Exception:
            # 生成失败的日志已经由 done callback 记过,这里不重复记
            return

    async def discard(self, schedule_id: str) -> None:
        """日程被删除时取消尚未完成的生成任务。"""
        task = self._tasks.pop(schedule_id, None)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def aclose(self) -> None:
        """应用关闭时取消所有在飞的生成任务。"""
        tasks = tuple(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _make_done_callback(self, schedule_id: str) -> Callable[[asyncio.Task[bool]], None]:
        def callback(completed: asyncio.Task[bool]) -> None:
            if self._tasks.get(schedule_id) is completed:
                self._tasks.pop(schedule_id, None)
            if completed.cancelled():
                return
            try:
                completed.result()
            except Exception:  # noqa: BLE001 - background generation must not break the WS loop
                logger.exception(
                    "Reminder audio generation failed", extra={"schedule_id": schedule_id}
                )

        return callback


class ReminderAudioSender:
    """Send one reminder control message followed by its current audio file."""

    def __init__(
        self,
        connections: ConnectionManager,
        storage: ReminderAudioStoragePort,
        *,
        stream_id_factory: Callable[[], str] | None = None,
        generation_tracker: ReminderAudioGenerationTracker | None = None,
        audio_wait_seconds: float = DEFAULT_AUDIO_WAIT_SECONDS,
    ) -> None:
        self._connections = connections
        self._storage = storage
        self._stream_id_factory = stream_id_factory or self._new_stream_id
        self._generation_tracker = generation_tracker
        self._audio_wait_seconds = audio_wait_seconds

    async def send_reminder(
        self,
        device_id: str,
        schedule_id: str,
        *,
        reason: str,
        action: str = "show",
    ) -> bool:
        """Deliver reminder control and audio to one connected device."""
        control = ReminderControl(
            schedule_id=schedule_id,
            reason=reason,
            action=action,
        ).model_dump()
        if self._generation_tracker is not None:
            # 刚创建就命中的日程(尤其是地理围栏,没有任何提前量),音频可能还在生成中;
            # 有界等待一下,超时就照常发纯文本,不让提醒被无限拖住。
            await self._generation_tracker.wait_for(schedule_id, self._audio_wait_seconds)
        audio = await self._storage.read(schedule_id)
        if audio is None:
            return await self._connections.send(device_id, control)

        stream_id = self._stream_id_factory()
        start = ReminderAudioStart(
            schedule_id=schedule_id,
            stream_id=stream_id,
            audio_format=audio.audio_format,
        ).model_dump()
        end = ReminderAudioEnd(
            schedule_id=schedule_id,
            stream_id=stream_id,
        ).model_dump()
        return await self._connections.send_audio(
            device_id,
            start,
            audio.data,
            end,
            preceding_message=control,
        )

    @staticmethod
    def _new_stream_id() -> str:
        return f"stream_reminder_{uuid4().hex}"


__all__ = ["ReminderAudioSender"]
