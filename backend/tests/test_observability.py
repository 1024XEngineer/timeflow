"""Tempo spans for tool order nest under a voice turn without payload attributes."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from observability_support import metric_value
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from timeflow.gateway.observability.http import install_http_observability
from timeflow.infrastructure.observability.tracing import reset_tracing_for_tests, start_span
from timeflow.observability import PrometheusOtelVoiceTelemetry

_EXPORTER: InMemorySpanExporter | None = None


def _span_exporter() -> InMemorySpanExporter:
    global _EXPORTER
    reset_tracing_for_tests()
    if _EXPORTER is None:
        _EXPORTER = InMemorySpanExporter()
    else:
        _EXPORTER.clear()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(_EXPORTER))
    trace.set_tracer_provider(provider)
    return _EXPORTER


def _assert_no_payload_attributes(exporter: InMemorySpanExporter) -> None:
    for span in exporter.get_finished_spans():
        names = set(span.attributes or {})
        assert "session.id" not in names
        assert not any("transcript" in key or "title" in key for key in names)
        assert "latitude" not in names
        assert "longitude" not in names


def test_tool_spans_preserve_call_order_under_the_turn() -> None:
    exporter = _span_exporter()
    telemetry = PrometheusOtelVoiceTelemetry()
    turns_before = metric_value(
        "timeflow_voice_turns_total",
        {"agent_mode": "composed", "voice_mode": "push_to_talk", "status": "completed"},
    )
    query_before = metric_value(
        "timeflow_tool_calls_total",
        {"tool": "schedule_query", "agent_mode": "composed", "status": "ok"},
    )

    turn = telemetry.start_turn(agent_mode="composed", voice_mode="push_to_talk")
    first = telemetry.start_tool("schedule_query", agent_mode="composed")
    first.finish(status="ok")
    second = telemetry.start_tool("schedule_create", agent_mode="composed")
    second.finish(status="ok")
    turn.record_stage("asr_total_ms", 12.0)
    turn.record_stage("turn_total_ms", None)
    turn.record_llm_usage(prompt_tokens=3, completion_tokens=5)
    telemetry.record_agent_timing(
        agent_mode="composed",
        llm_tool_call_ms=4.0,
        tool_execution_ms=6.0,
        llm_final_text_ms=8.0,
    )
    turn.finish(status="completed")

    spans = {span.name: span for span in exporter.get_finished_spans()}
    assert "voice.turn" in spans
    assert "tool.schedule_query" in spans
    assert "tool.schedule_create" in spans
    query = spans["tool.schedule_query"]
    create = spans["tool.schedule_create"]
    turn_span = spans["voice.turn"]
    assert query.attributes["timeflow.tool.sequence"] == 1
    assert create.attributes["timeflow.tool.sequence"] == 2
    assert query.parent is not None
    assert create.parent is not None
    assert query.parent.span_id == turn_span.context.span_id
    assert create.parent.span_id == turn_span.context.span_id
    assert turn_span.parent is None
    assert turn_span.attributes["timeflow.tools"] == "schedule_query,schedule_create"
    assert turn_span.attributes["timeflow.tool.count"] == 2
    assert [event.name for event in turn_span.events] == [
        "tool.schedule_query",
        "tool.schedule_create",
        "asr_total",
    ]
    _assert_no_payload_attributes(exporter)
    assert (
        metric_value(
            "timeflow_voice_turns_total",
            {"agent_mode": "composed", "voice_mode": "push_to_talk", "status": "completed"},
        )
        == turns_before + 1
    )
    assert (
        metric_value(
            "timeflow_tool_calls_total",
            {"tool": "schedule_query", "agent_mode": "composed", "status": "ok"},
        )
        == query_before + 1
    )


def test_unknown_tools_collapse_to_other_and_failed_turns_mark_error() -> None:
    exporter = _span_exporter()
    telemetry = PrometheusOtelVoiceTelemetry()
    other_before = metric_value(
        "timeflow_tool_calls_total",
        {"tool": "other", "agent_mode": "realtime", "status": "error"},
    )

    turn = telemetry.start_turn(agent_mode="realtime", voice_mode="continuous")
    tool = telemetry.start_tool("invented_secret_tool", agent_mode="realtime")
    tool.finish(status="error", error_kind="provider")
    turn.finish(status="failed")

    spans = {span.name: span for span in exporter.get_finished_spans()}
    assert "tool.other" in spans
    assert spans["tool.other"].attributes["timeflow.tool.sequence"] == 1
    assert spans["voice.turn"].status.status_code.name == "ERROR"
    assert spans["voice.turn"].attributes["timeflow.tools"] == "other"
    assert spans["voice.turn"].attributes["timeflow.tool.count"] == 1
    _assert_no_payload_attributes(exporter)
    assert (
        metric_value(
            "timeflow_tool_calls_total",
            {"tool": "other", "agent_mode": "realtime", "status": "error"},
        )
        == other_before + 1
    )


def test_voice_turn_starts_a_new_trace_while_a_websocket_session_is_open() -> None:
    exporter = _span_exporter()
    telemetry = PrometheusOtelVoiceTelemetry()
    session = trace.get_tracer("timeflow.gateway").start_span("ws.session")
    token = otel_context.attach(trace.set_span_in_context(session))
    try:
        turn = telemetry.start_turn(agent_mode="composed", voice_mode="continuous")
        tool = telemetry.start_tool("schedule_query", agent_mode="composed")
        tool.finish(status="ok")
        turn.finish(status="completed")
    finally:
        session.end()
        otel_context.detach(token)

    spans = {span.name: span for span in exporter.get_finished_spans()}
    turn_span = spans["voice.turn"]
    tool_span = spans["tool.schedule_query"]
    assert turn_span.parent is None
    assert turn_span.context.trace_id != session.get_span_context().trace_id
    assert tool_span.parent is not None
    assert tool_span.parent.span_id == turn_span.context.span_id
    assert turn_span.attributes["timeflow.tools"] == "schedule_query"
    assert len(turn_span.links) == 1
    assert turn_span.links[0].context.span_id == session.get_span_context().span_id
    _assert_no_payload_attributes(exporter)


def test_http_request_span_parents_work_started_inside_the_handler() -> None:
    exporter = _span_exporter()
    application = FastAPI()
    install_http_observability(application)

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        with start_span("db.select", attributes={"timeflow.db.operation": "SELECT"}):
            return {"status": "ok"}

    response = TestClient(application).get("/api/v1/health")

    assert response.status_code == 200
    spans = {span.name: span for span in exporter.get_finished_spans()}
    assert "http.request" in spans
    assert "db.select" in spans
    assert spans["db.select"].parent is not None
    assert spans["db.select"].parent.span_id == spans["http.request"].context.span_id
    _assert_no_payload_attributes(exporter)
