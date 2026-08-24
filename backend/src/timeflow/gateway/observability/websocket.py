"""WebSocket Prometheus instruments for handshake, sessions, and audio backpressure."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

_HANDSHAKE_RESULTS = frozenset(
    {
        "success",
        "timeout",
        "malformed",
        "auth_failed",
        "internal",
        "disconnect",
        "rejected_limiter",
    }
)
_DISCONNECT_REASONS = frozenset(
    {
        "client",
        "timeout",
        "malformed",
        "auth_failed",
        "internal",
        "disconnect",
        "limiter",
        "error",
    }
)
_TRUNCATE_REASONS = frozenset({"max_duration", "empty_stream"})

WS_HANDSHAKES = Counter(
    "timeflow_ws_handshakes_total",
    "WebSocket handshake attempts by bounded result.",
    ("result",),
)
WS_HANDSHAKE_DURATION = Histogram(
    "timeflow_ws_handshake_duration_seconds",
    "WebSocket handshake duration in seconds.",
    ("result",),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)
WS_DISCONNECTS = Counter(
    "timeflow_ws_disconnects_total",
    "WebSocket disconnects by bounded reason.",
    ("reason",),
)
WS_CONNECTIONS = Gauge(
    "timeflow_ws_connections",
    "Accepted WebSocket connections that have not yet closed, including handshake.",
)
WS_SESSIONS_ONLINE = Gauge(
    "timeflow_ws_sessions_online",
    "Authenticated WebSocket sessions currently registered.",
)
WS_AUDIO_QUEUE_DEPTH = Histogram(
    "timeflow_ws_audio_queue_depth",
    "Queued inbound audio chunks at enqueue time.",
    buckets=(0, 1, 2, 4, 8, 16, 32, 64),
)
WS_AUDIO_TRUNCATED = Counter(
    "timeflow_ws_audio_truncated_total",
    "Inbound audio streams cut for exceeding limits.",
    ("reason",),
)
WS_AUDIO_CHUNKS = Counter(
    "timeflow_ws_audio_chunks_total",
    "Inbound binary audio frames accepted onto a live stream.",
)


def _bound(value: str, allowed: frozenset[str], default: str = "other") -> str:
    return value if value in allowed else default


def record_ws_handshake(result: str, duration_seconds: float | None = None) -> None:
    """Record one handshake outcome. Session ids are never labels."""
    bounded = _bound(result, _HANDSHAKE_RESULTS)
    WS_HANDSHAKES.labels(bounded).inc()
    if duration_seconds is not None:
        WS_HANDSHAKE_DURATION.labels(bounded).observe(duration_seconds)


def record_ws_disconnect(reason: str) -> None:
    """Record why a WebSocket closed."""
    WS_DISCONNECTS.labels(_bound(reason, _DISCONNECT_REASONS)).inc()


def inc_ws_connections() -> None:
    """Count a socket after the ASGI accept."""
    WS_CONNECTIONS.inc()


def dec_ws_connections() -> None:
    """Count a socket that has left run_websocket_session."""
    WS_CONNECTIONS.dec()


def set_online_sessions(count: int) -> None:
    """Set the authenticated session gauge from ConnectionManager."""
    WS_SESSIONS_ONLINE.set(count)


def observe_audio_queue_depth(depth: int) -> None:
    """Observe backlog after enqueueing one audio chunk."""
    WS_AUDIO_QUEUE_DEPTH.observe(depth)


def record_audio_chunk() -> None:
    """Count one accepted binary audio frame."""
    WS_AUDIO_CHUNKS.inc()


def record_audio_truncated(reason: str) -> None:
    """Count a stream aborted for duration or empty-input limits."""
    WS_AUDIO_TRUNCATED.labels(_bound(reason, _TRUNCATE_REASONS)).inc()


__all__ = [
    "dec_ws_connections",
    "inc_ws_connections",
    "observe_audio_queue_depth",
    "record_audio_chunk",
    "record_audio_truncated",
    "record_ws_disconnect",
    "record_ws_handshake",
    "set_online_sessions",
]
