"""认证公开入口限流器测试。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, get_ident
from threading import Lock as ThreadLock

import pytest

import timeflow.gateway.http.rate_limit as rate_limit_module
from timeflow.gateway.http.rate_limit import AuthRateLimiter, RateLimitPolicy


def test_allow_enforces_the_client_window() -> None:
    limiter = AuthRateLimiter(RateLimitPolicy(client_limit=2, global_limit=10))

    assert limiter.allow("client-a") is True
    assert limiter.allow("client-a") is True
    assert limiter.allow("client-a") is False
    assert limiter.allow("client-b") is True


def test_allow_enforces_the_global_window_across_clients() -> None:
    limiter = AuthRateLimiter(RateLimitPolicy(client_limit=10, global_limit=2))

    assert limiter.allow("client-a") is True
    assert limiter.allow("client-b") is True
    assert limiter.allow("client-c") is False


def test_rejected_client_request_does_not_consume_global_budget() -> None:
    limiter = AuthRateLimiter(RateLimitPolicy(client_limit=1, global_limit=2))

    assert limiter.allow("client-a") is True
    assert limiter.allow("client-a") is False
    assert limiter.allow("client-b") is True


def test_allow_reopens_after_the_window_expires() -> None:
    now = [0.0]
    limiter = AuthRateLimiter(
        RateLimitPolicy(client_limit=1, global_limit=1, window_seconds=10),
        clock=lambda: now[0],
    )

    assert limiter.allow("client-a") is True
    assert limiter.allow("client-a") is False
    now[0] = 10.0
    assert limiter.allow("client-a") is True


def test_allow_is_thread_safe_and_respects_global_limit() -> None:
    limiter = AuthRateLimiter(RateLimitPolicy(client_limit=100, global_limit=5))

    with ThreadPoolExecutor(max_workers=20) as executor:
        results = list(executor.map(lambda index: limiter.allow(f"client-{index}"), range(100)))

    assert sum(results) == 5


def test_concurrent_clock_reads_are_locked_and_events_remain_ordered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """并发请求读取时钟时持有锁，避免事件队列留下逆序时间戳。"""
    locks: list[object] = []
    clock_lock_states: list[bool] = []

    class TrackingLock:
        """记录当前线程是否持有生产限流器使用的互斥锁。"""

        def __init__(self) -> None:
            self._lock = ThreadLock()
            self.owner: int | None = None
            locks.append(self)

        def __enter__(self) -> "TrackingLock":
            self._lock.acquire()
            self.owner = get_ident()
            return self

        def __exit__(self, *_args: object) -> None:
            self.owner = None
            self._lock.release()

    monkeypatch.setattr(rate_limit_module, "Lock", TrackingLock)
    clock_values = iter((0.0, 1.0, 2.0))

    def clock() -> float:
        assert locks
        lock = locks[0]
        assert isinstance(lock, TrackingLock)
        clock_lock_states.append(lock.owner == get_ident())
        return next(clock_values)

    limiter = AuthRateLimiter(
        RateLimitPolicy(client_limit=10, global_limit=2, window_seconds=2),
        clock=clock,
    )
    barrier = Barrier(2)

    def invoke(client_key: str) -> bool:
        barrier.wait()
        return limiter.allow(client_key)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(invoke, key) for key in ("client-a", "client-b")]
        results = [future.result(timeout=2) for future in futures]

    assert results == [True, True]
    assert clock_lock_states == [True, True]
    # t=0、t=1 的事件按调用顺序写入；t=2 时窗口会清理 t=0，第三次请求可进入。
    assert limiter.allow("client-c") is True


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"client_limit": 0}, "client_limit must be a positive integer"),
        ({"global_limit": 0}, "global_limit must be a positive integer"),
        ({"window_seconds": 0}, "window_seconds must be a positive finite number"),
        ({"window_seconds": float("inf")}, "window_seconds must be a positive finite number"),
    ],
)
def test_policy_rejects_invalid_limits(kwargs: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        RateLimitPolicy(**kwargs)  # type: ignore[arg-type]
