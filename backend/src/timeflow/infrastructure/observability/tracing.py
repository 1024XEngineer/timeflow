"""OpenTelemetry tracer configuration for Tempo export."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from timeflow.infrastructure.settings import Settings

_configured = False
TRACER_NAME = "timeflow"


def configure_tracing(settings: Settings, *, force: bool = False) -> None:
    """Install a process-wide tracer provider, exporting to Tempo when configured."""
    global _configured
    if _configured and not force:
        return
    if not settings.otel_traces_enabled or not settings.otel_exporter_otlp_endpoint:
        _configured = True
        return

    resource = Resource.create({"service.name": settings.otel_service_name})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=_traces_endpoint(settings)))
    )
    trace.set_tracer_provider(provider)
    _configured = True


def reset_tracing_for_tests() -> None:
    """Allow tests to reinstall a tracer provider. Not used in production.

    OpenTelemetry's ``set_tracer_provider`` is process-wide and once-only.
    Importing the app with a local Tempo endpoint would otherwise lock a real
    exporter in place and leave in-memory test exporters empty.
    """
    global _configured
    _configured = False
    trace._TRACER_PROVIDER = None
    once = getattr(trace, "_TRACER_PROVIDER_SET_ONCE", None)
    if once is not None:
        once._done = False


def get_tracer(name: str = TRACER_NAME) -> trace.Tracer:
    """Return the process tracer, which is a no-op until a provider is installed."""
    return trace.get_tracer(name)


def _traces_endpoint(settings: Settings) -> str:
    endpoint = settings.otel_exporter_otlp_endpoint.rstrip("/")
    if endpoint.endswith("/v1/traces"):
        return endpoint
    return f"{endpoint}/v1/traces"


@contextmanager
def start_span(
    name: str,
    *,
    kind: SpanKind = SpanKind.INTERNAL,
    attributes: Mapping[str, str | bool | int | float] | None = None,
) -> Iterator[Span]:
    """Start a current span and record exceptions without putting payloads on it."""
    span_attributes: Mapping[str, str | bool | int | float] = attributes or {}
    tracer = get_tracer()
    with tracer.start_as_current_span(name, kind=kind, attributes=span_attributes) as span:
        try:
            yield span
        except BaseException:
            span.set_status(Status(StatusCode.ERROR))
            raise


def mark_error(span: Span, error_kind: str) -> None:
    """Tag a span as failed using a bounded error kind, never the exception text."""
    span.set_attribute("timeflow.error_kind", error_kind)
    span.set_status(Status(StatusCode.ERROR))


__all__ = [
    "TRACER_NAME",
    "configure_tracing",
    "get_tracer",
    "mark_error",
    "reset_tracing_for_tests",
    "start_span",
]
