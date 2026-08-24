"""WebSocket handshake, session, and audio-backpressure instruments."""

from observability_support import metric_value

from timeflow.gateway.observability import record_ws_handshake
from timeflow.gateway.observability.websocket import (
    dec_ws_connections,
    inc_ws_connections,
    observe_audio_queue_depth,
    record_audio_chunk,
    record_audio_truncated,
    record_ws_disconnect,
    set_online_sessions,
)


def test_handshake_and_disconnect_use_bounded_labels() -> None:
    success_before = metric_value("timeflow_ws_handshakes_total", {"result": "success"})
    timeout_before = metric_value("timeflow_ws_handshakes_total", {"result": "timeout"})
    other_before = metric_value("timeflow_ws_handshakes_total", {"result": "other"})
    client_before = metric_value("timeflow_ws_disconnects_total", {"reason": "client"})

    record_ws_handshake("success")
    record_ws_handshake("timeout", 0.04)
    record_ws_handshake("session-id-must-never-be-a-label")
    record_ws_disconnect("client")

    assert metric_value("timeflow_ws_handshakes_total", {"result": "success"}) == success_before + 1
    assert metric_value("timeflow_ws_handshakes_total", {"result": "timeout"}) == timeout_before + 1
    assert metric_value("timeflow_ws_handshakes_total", {"result": "other"}) == other_before + 1
    assert metric_value("timeflow_ws_disconnects_total", {"reason": "client"}) == client_before + 1


def test_online_sessions_and_audio_backpressure_are_numeric_only() -> None:
    truncated_before = metric_value("timeflow_ws_audio_truncated_total", {"reason": "max_duration"})
    chunks_before = metric_value("timeflow_ws_audio_chunks_total")
    connections_before = metric_value("timeflow_ws_connections")
    set_online_sessions(3)
    observe_audio_queue_depth(4)
    record_audio_truncated("max_duration")
    record_audio_chunk()
    inc_ws_connections()
    dec_ws_connections()

    assert metric_value("timeflow_ws_sessions_online") == 3
    assert metric_value("timeflow_ws_connections") == connections_before
    assert metric_value("timeflow_ws_audio_chunks_total") == chunks_before + 1
    assert (
        metric_value("timeflow_ws_audio_truncated_total", {"reason": "max_duration"})
        == truncated_before + 1
    )
