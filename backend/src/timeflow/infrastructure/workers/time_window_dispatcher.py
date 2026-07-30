"""周期性判定日程是否进入提醒窗口,并通过 WS 推送提醒或发起系统日历引用检查。"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from timeflow.business.schedules.reminder_dispatch import (
    NextStep,
    RefsCheckOutcome,
    TriggeredSchedule,
    decide_after_refs_check,
)
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.messages.reminder import (
    ReminderControl,
    SystemRefsCheck,
    SystemScheduleDelete,
)

DEFAULT_POLL_INTERVAL_SECONDS = 30.0
DEFAULT_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True, slots=True)
class _PendingCheck:
    """一条已发出系统引用检查、还在等待客户端回复的日程。"""

    user_id: str
    system_schedule_ref_id: str
    sent_at: datetime


class TimeWindowDispatcher:
    """把 `TimeWindowTriggerService` 的判定结果转成真正的 WS 推送。"""

    def __init__(
        self,
        connections: ConnectionManager,
        run_tick: Callable[[datetime], list[TriggeredSchedule]],
        cancel_schedule: Callable[[str], None],
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._connections = connections
        self._run_tick = run_tick
        self._cancel_schedule = cancel_schedule
        self._poll_interval_seconds = poll_interval_seconds
        self._timeout_seconds = timeout_seconds
        self._pending: dict[str, _PendingCheck] = {}

    async def run_forever(self) -> None:
        """周期性 tick,直到外部取消这个协程。"""
        while True:
            await self.tick(datetime.now())
            await asyncio.sleep(self._poll_interval_seconds)

    async def tick(self, now: datetime) -> None:
        """跑一轮:处理新命中的日程,再扫一遍待回复登记表里的超时项。"""
        triggered = await asyncio.to_thread(self._run_tick, now)
        for schedule in triggered:
            await self._dispatch(schedule, now)
        await self._sweep_timeouts(now)

    async def handle_refs_check_reply(self, schedule_id: str, calendar_exists: bool) -> None:
        """WS 层收到客户端真实回复时调用。

        如果这个 schedule_id 已经不在待回复登记表里(迟到、重复,或已被超时扫描处理过),
        直接丢弃,不做任何处理。
        """
        pending = self._pending.pop(schedule_id, None)
        if pending is None:
            return
        await self._resolve(schedule_id, pending, calendar_exists)

    async def _dispatch(self, schedule: TriggeredSchedule, now: datetime) -> None:
        if schedule.next_step is NextStep.NEEDS_REFS_CHECK:
            ref_id = schedule.system_schedule_ref_id
            assert ref_id is not None
            await self._connections.send(
                schedule.user_id,
                SystemRefsCheck(
                    schedule_id=schedule.schedule_id,
                    system_schedule_ref_id=ref_id,
                    reason="before_reminder_control",
                ).model_dump(),
            )
            self._pending[schedule.schedule_id] = _PendingCheck(
                user_id=schedule.user_id,
                system_schedule_ref_id=ref_id,
                sent_at=now,
            )
        else:
            await self._remind(schedule.schedule_id, schedule.user_id, schedule.system_schedule_ref_id)

    async def _sweep_timeouts(self, now: datetime) -> None:
        expired = [
            schedule_id
            for schedule_id, pending in self._pending.items()
            if (now - pending.sent_at).total_seconds() >= self._timeout_seconds
        ]
        for schedule_id in expired:
            pending = self._pending.pop(schedule_id)
            await self._resolve(schedule_id, pending, calendar_exists=True)

    async def _resolve(self, schedule_id: str, pending: _PendingCheck, calendar_exists: bool) -> None:
        outcome = decide_after_refs_check(calendar_exists)
        if outcome is RefsCheckOutcome.CANCEL:
            await asyncio.to_thread(self._cancel_schedule, schedule_id)
            return
        await self._remind(schedule_id, pending.user_id, pending.system_schedule_ref_id)

    async def _remind(
        self, schedule_id: str, user_id: str, system_schedule_ref_id: str | None
    ) -> None:
        await self._connections.send(
            user_id,
            ReminderControl(
                schedule_id=schedule_id, reason="time_window_reached", action="show"
            ).model_dump(),
        )
        if system_schedule_ref_id is not None:
            await self._connections.send(
                user_id,
                SystemScheduleDelete(
                    schedule_id=schedule_id,
                    system_schedule_ref_id=system_schedule_ref_id,
                    reason="ws_connected_and_time_near",
                ).model_dump(),
            )
