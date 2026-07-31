"""下发 `reminder.control` 并处理 ack 超时重试,不区分触发来源(时间轮询/地理围栏等事件)。"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.messages.reminder import ReminderControl

DEFAULT_POLL_INTERVAL_SECONDS = 30.0
DEFAULT_ACK_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_ATTEMPTS = 3

logger = logging.getLogger(__name__)


class _ReminderSender(Protocol):
    async def send_reminder(
        self,
        device_id: str,
        schedule_id: str,
        *,
        reason: str,
        action: str = "show",
    ) -> bool: ...


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
        reminder_sender: _ReminderSender | None = None,
        mark_done: Callable[[str, datetime], bool] | None = None,
    ) -> None:
        self._connections = connections
        self._reminder_sender = reminder_sender
        self._mark_done = mark_done
        self._run_tick = run_tick
        self._poll_interval_seconds = poll_interval_seconds
        self._ack_timeout_seconds = ack_timeout_seconds
        self._max_attempts = max_attempts
        self._pending: dict[str, _PendingAck] = {}

    async def run_forever(self) -> None:
        """周期性 tick,直到外部取消这个协程。单轮 tick 异常不能中止后续轮次。"""
        while True:
            try:
                await self.tick(datetime.now(UTC))
            except Exception:
                logger.exception("reminder dispatcher tick failed")
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

    async def handle_ack(self, schedule_id: str, device_id: str) -> None:
        """客户端确认执行完成后调用;不在登记表里(未知或已处理过)则直接丢弃。
        必须来自当初收到这条提醒的设备——否则任意连接只要猜到 schedule_id
        就能清除别的设备的待确认状态。

        确认通过后把日程置为 `done`,结束后续监听(架构设计.md §8.4)。
        这一步放在设备校验之后,伪造的 ack 不能把别人的日程标记成已完成。
        """
        pending = self._pending.get(schedule_id)
        if pending is None or pending.schedule.user_id != device_id:
            return
        if self._mark_done is not None:
            try:
                await asyncio.to_thread(self._mark_done, schedule_id, datetime.now(UTC))
            except Exception:
                # 写失败时**保留**待确认登记,让既有的超时重发路径再给一次机会。
                # 如果这里直接清掉,日程会永远停在 `scheduled`——触发时间戳已经写死,
                # 两条候选查询都不会再选中它,没有任何补救路径。
                # 代价是数据库故障期间客户端可能收到重复提醒(受 max_attempts 约束)。
                logger.exception(
                    "failed to mark schedule %s as done; keeping it pending for retry",
                    schedule_id,
                )
                return
        # 写成功,或者返回 False(没有匹配的行:日程已删除/已是 done)都属于终态,
        # 不需要再重试,可以安全清除待确认登记。
        self._pending.pop(schedule_id, None)

    async def _send(self, schedule: TriggeredSchedule, now: datetime, attempt: int) -> None:
        # 发送前先登记,而不是发送成功后再登记:_connections.send() 内部有真正的 await,
        # 如果先发后登记,并发到达的 handle_ack 会因为这时候 _pending 里还没有这一条而被
        # 静默丢弃,发送完成后又被无条件重新登记成待确认——把一条已经确认过的提醒错误地
        # 变回"待确认"状态。先登记可以保证 handle_ack 在任意时刻并发进来都能找到并清除它。
        self._pending[schedule.schedule_id] = _PendingAck(
            schedule=schedule, sent_at=now, attempt=attempt
        )
        if self._reminder_sender is not None:
            sent = await self._reminder_sender.send_reminder(
                schedule.user_id,
                schedule.schedule_id,
                reason=schedule.reason,
            )
        else:
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
            self._pending.pop(schedule.schedule_id, None)

    async def _sweep_ack_timeouts(self, now: datetime) -> None:
        expired = [
            schedule_id
            for schedule_id, pending in self._pending.items()
            if (now - pending.sent_at).total_seconds() >= self._ack_timeout_seconds
        ]
        for schedule_id in expired:
            # 用 get 而不是不带默认值的 pop:上一个 schedule_id 的 _send() await 期间,
            # handle_ack 可能已经并发处理过(甚至清除过)这一条,直接跳过而不是抛 KeyError。
            pending = self._pending.get(schedule_id)
            if pending is None:
                continue
            if pending.attempt >= self._max_attempts:
                logger.warning(
                    "reminder.control ack timed out after %d attempts for schedule %s",
                    pending.attempt,
                    schedule_id,
                )
                self._pending.pop(schedule_id, None)
                continue
            await self._send(pending.schedule, now, attempt=pending.attempt + 1)
