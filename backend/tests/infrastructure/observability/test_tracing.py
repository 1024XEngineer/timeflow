"""Tracing helpers for Tempo export configuration."""

from unittest.mock import patch

from timeflow.infrastructure.observability import configure_observability
from timeflow.infrastructure.observability.tracing import (
    _traces_endpoint,
    configure_tracing,
    mark_error,
    reset_tracing_for_tests,
    start_span,
)
from timeflow.infrastructure.settings import Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "app_name": "t",
        "environment": "test",
        "database_url": "sqlite+pysqlite:///:memory:",
        "ws_handshake_timeout_seconds": 5.0,
        "ws_max_unauthenticated_connections": 1,
        "ws_audio_queue_max_chunks": 1,
        "ws_max_audio_duration_ms": 1000,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_traces_endpoint_appends_the_otlp_http_path() -> None:
    settings = _settings(otel_exporter_otlp_endpoint="http://tempo:4318")
    assert _traces_endpoint(settings) == "http://tempo:4318/v1/traces"
    settings_full = _settings(otel_exporter_otlp_endpoint="http://tempo:4318/v1/traces")
    assert _traces_endpoint(settings_full) == "http://tempo:4318/v1/traces"


def test_configure_tracing_without_endpoint_is_a_noop() -> None:
    reset_tracing_for_tests()
    configure_observability(_settings(otel_traces_enabled=True, otel_exporter_otlp_endpoint=""))


def test_configure_tracing_installs_an_exporter_when_enabled() -> None:
    reset_tracing_for_tests()
    settings = _settings(
        otel_traces_enabled=True,
        otel_exporter_otlp_endpoint="http://tempo:4318",
        otel_service_name="timeflow-test",
    )
    with (
        patch("timeflow.infrastructure.observability.tracing.OTLPSpanExporter") as exporter,
        patch("timeflow.infrastructure.observability.tracing.trace.set_tracer_provider"),
        patch("timeflow.infrastructure.observability.tracing.BatchSpanProcessor"),
        patch("timeflow.infrastructure.observability.tracing.TracerProvider"),
    ):
        configure_tracing(settings, force=True)
    exporter.assert_called_once()


def test_configure_tracing_is_idempotent_without_force() -> None:
    reset_tracing_for_tests()
    configure_tracing(_settings(), force=True)
    with patch("timeflow.infrastructure.observability.tracing.OTLPSpanExporter") as exporter:
        configure_tracing(
            _settings(otel_traces_enabled=True, otel_exporter_otlp_endpoint="http://tempo:4318")
        )
    exporter.assert_not_called()


def test_reset_tracing_allows_a_new_provider_after_the_app_has_configured() -> None:
    reset_tracing_for_tests()
    configure_tracing(_settings(), force=True)
    reset_tracing_for_tests()
    with (
        patch("timeflow.infrastructure.observability.tracing.OTLPSpanExporter"),
        patch("timeflow.infrastructure.observability.tracing.BatchSpanProcessor"),
        patch("timeflow.infrastructure.observability.tracing.TracerProvider"),
        patch("timeflow.infrastructure.observability.tracing.trace.set_tracer_provider") as setter,
    ):
        configure_tracing(
            _settings(
                otel_traces_enabled=True,
                otel_exporter_otlp_endpoint="http://tempo:4318",
            ),
            force=True,
        )
    setter.assert_called_once()


def test_start_span_records_errors_without_exception_text() -> None:
    with start_span("test.span", attributes={"timeflow.dependency": "llm"}) as span:
        mark_error(span, "provider")


def test_start_span_marks_exceptions_without_attaching_the_message() -> None:
    try:
        with start_span("test.fail"):
            raise RuntimeError("this must not become a span attribute")
    except RuntimeError:
        pass
