"""认证公开入口使用的进程内滑动窗口限流器。"""

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from math import ceil, isfinite
from threading import Lock
from time import monotonic


@dataclass(frozen=True, slots=True)
class RateLimitPolicy:
    """定义单客户端和全局认证请求的窗口限制。"""

    client_limit: int = 20
    global_limit: int = 300
    window_seconds: float = 60.0

    def __post_init__(self) -> None:
        if (
            not isinstance(self.client_limit, int)
            or isinstance(self.client_limit, bool)
            or self.client_limit <= 0
        ):
            raise ValueError("client_limit must be a positive integer")
        if (
            not isinstance(self.global_limit, int)
            or isinstance(self.global_limit, bool)
            or self.global_limit <= 0
        ):
            raise ValueError("global_limit must be a positive integer")
        if not isinstance(self.window_seconds, (int, float)) or isinstance(
            self.window_seconds, bool
        ):
            raise ValueError("window_seconds must be a positive finite number")
        if not isfinite(float(self.window_seconds)) or self.window_seconds <= 0:
            raise ValueError("window_seconds must be a positive finite number")


class AuthRateLimiter:
    """在单进程内原子限制认证请求，避免无限触发密码哈希。

    这是部署层共享限流前的进程内防线，多实例生产环境仍需由可信网关统一限流。
    """

    def __init__(
        self,
        policy: RateLimitPolicy | None = None,
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._policy = policy or RateLimitPolicy()
        self._clock = clock
        self._global_events: deque[float] = deque()
        self._client_events: dict[str, deque[float]] = {}
        self._lock = Lock()

    @property
    def retry_after_seconds(self) -> int:
        """返回客户端应等待的最小窗口秒数。"""
        return max(1, ceil(float(self._policy.window_seconds)))

    def allow(self, client_key: str) -> bool:
        """判断请求是否可继续，并在允许时同时记入两个窗口。"""
        if not isinstance(client_key, str) or not client_key:
            client_key = "unknown"

        with self._lock:
            # 在同一把锁内读取时钟并写入事件，保持滑动窗口队列按时间有序。
            now = self._clock()
            self._prune(now)
            client_events = self._client_events.get(client_key)
            if len(self._global_events) >= self._policy.global_limit:
                return False
            if client_events is not None and len(client_events) >= self._policy.client_limit:
                return False

            self._global_events.append(now)
            if client_events is None:
                client_events = deque()
                self._client_events[client_key] = client_events
            client_events.append(now)
            return True

    def _prune(self, now: float) -> None:
        cutoff = now - float(self._policy.window_seconds)
        while self._global_events and self._global_events[0] <= cutoff:
            self._global_events.popleft()

        for client_key, events in tuple(self._client_events.items()):
            while events and events[0] <= cutoff:
                events.popleft()
            if not events:
                del self._client_events[client_key]


__all__ = ["AuthRateLimiter", "RateLimitPolicy"]
