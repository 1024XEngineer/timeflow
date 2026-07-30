"""下发 `reminder.control` 并处理 ack 超时重试,不区分触发来源(时间轮询/地理围栏等事件)。"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.messages.reminder import ReminderControl

DEFAULT_POLL_INTERVAL_SECONDS = 30.0
DEFAULT_ACK_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_ATTEMPTS = 3

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _PendingAck:
    """已下发、还在等待客户端 `reminder.control.ack` 的一次提醒。"""

    schedule: TriggeredSchedule
    sent_at: datetime
    attempt: int


class ReminderDispatcher:
    """把已经命中的提醒转成真正的 WS 推送,并处理 ack 超时重试。

    命中判定本身不在这里做——`run_tick` 只负责轮询产生的时间维度命中;
    事件驱动的触发来源(比如地理围栏的 `location.report`)可以直接调用 `dispatch(...)`,
    跟轮询产生的提醒共用同一份待确认登记表和超时重试逻辑。
    """

    def __init__(
        self,
        connections: ConnectionManager,
        run_tick: Callable[[datetime], list[TriggeredSchedule]],
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
        ack_timeout_seconds: float = DEFAULT_ACK_TIMEOUT_SECONDS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> None:
        self._connections = connections
        self._run_tick = run_tick
        self._poll_interval_seconds = poll_interval_seconds
        self._ack_timeout_seconds = ack_timeout_seconds
        self._max_attempts = max_attempts
        self._pending: dict[str, _PendingAck] = {}

    async def run_forever(self) -> None:
        """周期性 tick,直到外部取消这个协程。"""
        while True:
            await self.tick(datetime.now(UTC))
            await asyncio.sleep(self._poll_interval_seconds)

    async def tick(self, now: datetime) -> None:
        """跑一轮:轮询产生的时间维度新命中走 dispatch,再扫一遍待确认登记表里的超时项
        (不分触发来源,事件驱动提前登记的项也会在这里被扫到)。"""
        triggered = await asyncio.to_thread(self._run_tick, now)
        await self.dispatch(triggered, now)
        await self._sweep_ack_timeouts(now)

    async def dispatch(self, schedules: list[TriggeredSchedule], now: datetime) -> None:
        """通用入口:不管命中来源是轮询(时间)还是事件驱动(比如地理围栏),
        都从这里进来发送 `reminder.control` 并登记待确认。"""
        for schedule in schedules:
            await self._send(schedule, now, attempt=1)

    async def handle_ack(self, schedule_id: str) -> None:
        """客户端确认执行完成后调用;不在登记表里(未知或已处理过)则直接丢弃。"""
        self._pending.pop(schedule_id, None)

    async def _send(self, schedule: TriggeredSchedule, now: datetime, attempt: int) -> None:
        sent = await self._connections.send(
            schedule.user_id,
            ReminderControl(
                schedule_id=schedule.schedule_id,
                reason=schedule.reason,
                action="show",
            ).model_dump(),
        )
        if not sent:
            # 设备离线:客户端根据自身能力降级为普通通知,不需要服务端等待 ack
            return
        self._pending[schedule.schedule_id] = _PendingAck(
            schedule=schedule, sent_at=now, attempt=attempt
        )

    async def _sweep_ack_timeouts(self, now: datetime) -> None:
        expired = [
            schedule_id
            for schedule_id, pending in self._pending.items()
            if (now - pending.sent_at).total_seconds() >= self._ack_timeout_seconds
        ]
        for schedule_id in expired:
            pending = self._pending.pop(schedule_id)
            if pending.attempt >= self._max_attempts:
                logger.warning(
                    "reminder.control ack timed out after %d attempts for schedule %s",
                    pending.attempt,
                    schedule_id,
                )
                continue
            await self._send(pending.schedule, now, attempt=pending.attempt + 1)
