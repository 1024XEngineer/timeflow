"""Gateway-owned Prometheus instruments and Tempo spans for HTTP and WebSocket."""

from timeflow.gateway.observability.http import (
    install_http_observability,
    record_auth_access,
    record_health,
    record_reminder_state,
    record_schedule_snapshot,
)
from timeflow.gateway.observability.websocket import (
    dec_ws_connections,
    inc_ws_connections,
    observe_audio_queue_depth,
    record_audio_chunk,
    record_audio_truncated,
    record_ws_disconnect,
    record_ws_handshake,
    set_online_sessions,
)

__all__ = [
    "dec_ws_connections",
    "inc_ws_connections",
    "install_http_observability",
    "observe_audio_queue_depth",
    "record_audio_chunk",
    "record_audio_truncated",
    "record_auth_access",
    "record_health",
    "record_reminder_state",
    "record_schedule_snapshot",
    "record_ws_disconnect",
    "record_ws_handshake",
    "set_online_sessions",
]
