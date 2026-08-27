"""Outbound provider call timing shared by ASR, LLM, TTS, maps, and realtime."""

from __future__ import annotations

import asyncio
import time
from types import TracebackType

from opentelemetry import context as otel_context
from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context

from timeflow.infrastructure.observability.metrics import (
    EXTERNAL_DURATION,
    EXTERNAL_FIRST_BYTE,
    EXTERNAL_IN_FLIGHT,
    EXTERNAL_REQUESTS,
    bound_dependency,
    bound_error_kind,
    bound_operation,
    bound_status,
)
from timeflow.infrastructure.observability.tracing import get_tracer


class ExternalCall:
    """Time one outbound call, emit Prometheus samples, and wrap it in a Tempo span.

    Request bodies, transcripts, coordinates, and credentials are never recorded.
    """

    def __init__(self, dependency: str, operation: str) -> None:
        self._dependency = bound_dependency(dependency)
        self._operation = bound_operation(operation)
        self._started = time.perf_counter()
        self._first_byte_at: float | None = None
        self._status = "ok"
        self._error_kind = "none"
        self._span = get_tracer().start_span(
            f"{self._dependency}.{self._operation}",
            kind=SpanKind.CLIENT,
            attributes={
                "timeflow.dependency": self._dependency,
                "timeflow.operation": self._operation,
            },
        )
        self._token = otel_context.attach(set_span_in_context(self._span))
        EXTERNAL_IN_FLIGHT.labels(self._dependency).inc()

    def mark_first_byte(self) -> None:
        """Record time-to-first-useful-event once, typically the first audio or token."""
        if self._first_byte_at is not None:
            return
        self._first_byte_at = time.perf_counter()
        EXTERNAL_FIRST_BYTE.labels(self._dependency, self._operation).observe(
            self._first_byte_at - self._started
        )
        self._span.set_attribute(
            "timeflow.first_byte_ms",
            round((self._first_byte_at - self._started) * 1000, 1),
        )

    def fail(self, error_kind: str) -> None:
        """Mark the call as failed using a bounded error classification."""
        self._status = "error"
        self._error_kind = bound_error_kind(error_kind)
        self._span.set_attribute("timeflow.error_kind", self._error_kind)
        self._span.set_status(Status(StatusCode.ERROR))

    def cancel(self) -> None:
        """Mark the call as cancelled by the caller rather than the provider."""
        self._status = "cancelled"
        self._error_kind = "cancelled"

    def __enter__(self) -> ExternalCall:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc, traceback
        if exc_type is not None and self._status == "ok":
            if exc_type is TimeoutError:
                self.fail("timeout")
            elif issubclass(exc_type, asyncio.CancelledError):
                self.cancel()
            else:
                self.fail("exception")
        duration = time.perf_counter() - self._started
        status = bound_status(self._status)
        EXTERNAL_REQUESTS.labels(
            self._dependency,
            self._operation,
            status,
            bound_error_kind(self._error_kind),
        ).inc()
        EXTERNAL_DURATION.labels(self._dependency, self._operation, status).observe(duration)
        self._span.set_attribute("timeflow.status", status)
        self._span.end()
        otel_context.detach(self._token)
        EXTERNAL_IN_FLIGHT.labels(self._dependency).dec()

    async def __aenter__(self) -> ExternalCall:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, traceback)


__all__ = ["ExternalCall"]
