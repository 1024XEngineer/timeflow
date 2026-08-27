"""HTTP Prometheus instruments, ASGI middleware, and the scrape endpoint."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from fastapi import APIRouter, FastAPI
from opentelemetry import context as otel_context
from opentelemetry.trace import SpanKind, Status, StatusCode, get_tracer, set_span_in_context
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from starlette.requests import Request
from starlette.responses import Response

HTTP_LATENCY_BUCKETS = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

HTTP_REQUESTS = Counter(
    "timeflow_http_requests_total",
    "HTTP requests by method, route template, and status code.",
    ("method", "route", "status_code"),
)
HTTP_DURATION = Histogram(
    "timeflow_http_request_duration_seconds",
    "HTTP request duration in seconds, including handler time.",
    ("method", "route"),
    buckets=HTTP_LATENCY_BUCKETS,
)
HTTP_IN_FLIGHT = Gauge(
    "timeflow_http_requests_in_flight",
    "HTTP requests currently being handled.",
)
AUTH_ACCESS = Counter(
    "timeflow_http_auth_access_total",
    "POST /api/v1/auth/access outcomes.",
    ("result",),
)
AUTH_ACCESS_DURATION = Histogram(
    "timeflow_http_auth_access_duration_seconds",
    "POST /api/v1/auth/access duration in seconds.",
    buckets=HTTP_LATENCY_BUCKETS,
)
SCHEDULE_SNAPSHOT = Counter(
    "timeflow_http_schedule_snapshot_total",
    "GET /api/v1/schedule/snapshot outcomes.",
    ("result",),
)
SCHEDULE_SNAPSHOT_DURATION = Histogram(
    "timeflow_http_schedule_snapshot_duration_seconds",
    "GET /api/v1/schedule/snapshot duration in seconds.",
    buckets=HTTP_LATENCY_BUCKETS,
)
SCHEDULE_SNAPSHOT_SERVER_ERRORS = Counter(
    "timeflow_http_schedule_snapshot_server_errors_total",
    "GET /api/v1/schedule/snapshot 5xx responses.",
)
REMINDER_STATE = Counter(
    "timeflow_http_reminder_state_total",
    "PUT /api/v1/schedule/reminder-state outcomes.",
    ("result",),
)
REMINDER_STATE_DURATION = Histogram(
    "timeflow_http_reminder_state_duration_seconds",
    "PUT /api/v1/schedule/reminder-state duration in seconds.",
    buckets=HTTP_LATENCY_BUCKETS,
)
HEALTH_LIVENESS = Counter(
    "timeflow_health_liveness_total",
    "GET /api/v1/health process-liveness checks.",
)
DEPENDENCY_READY = Gauge(
    "timeflow_gateway_dependency_ready",
    "1 when a dependency check reports ready or configured, 0 otherwise.",
    ("dependency",),
)

_AUTH_RESULTS = frozenset({"success", "failure", "rate_limited"})
_SNAPSHOT_RESULTS = frozenset({"success", "error"})
_REMINDER_RESULTS = frozenset({"confirmed", "not_found", "conflict", "error", "invalid"})
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"})
_SKIP_PATHS = frozenset({"/metrics"})
_KNOWN_ROUTES = frozenset(
    {
        "/api/v1/health",
        "/api/v1/auth/access",
        "/api/v1/schedule/snapshot",
        "/api/v1/schedule/reminder-state",
        "/metrics",
    }
)


def _bound(value: str, allowed: frozenset[str], default: str = "other") -> str:
    return value if value in allowed else default


def record_auth_access(result: str, duration_seconds: float) -> None:
    """Record one auth-access attempt. Result is success, failure, or rate_limited."""
    AUTH_ACCESS.labels(_bound(result, _AUTH_RESULTS)).inc()
    AUTH_ACCESS_DURATION.observe(duration_seconds)


def record_schedule_snapshot(result: str, duration_seconds: float, *, server_error: bool) -> None:
    """Record one schedule snapshot fetch, including 5xx separately."""
    SCHEDULE_SNAPSHOT.labels(_bound(result, _SNAPSHOT_RESULTS)).inc()
    SCHEDULE_SNAPSHOT_DURATION.observe(duration_seconds)
    if server_error:
        SCHEDULE_SNAPSHOT_SERVER_ERRORS.inc()


def record_reminder_state(result: str, duration_seconds: float) -> None:
    """Record one reminder confirmation, including 404 and 409."""
    REMINDER_STATE.labels(_bound(result, _REMINDER_RESULTS)).inc()
    REMINDER_STATE_DURATION.observe(duration_seconds)


def record_health(checks: dict[str, str]) -> None:
    """Record process liveness and per-dependency readiness gauges."""
    HEALTH_LIVENESS.inc()
    for name, value in checks.items():
        ready = 1.0 if value in {"ok", "configured"} else 0.0
        DEPENDENCY_READY.labels(name).set(ready)


class HttpMetricsMiddleware:
    """Count every HTTP request except /metrics, with route templates and P95-ready duration."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") in _SKIP_PATHS:
            await self.app(scope, receive, send)
            return

        method = _bound(str(scope.get("method", "GET")), _METHODS)
        status_code = 500
        started = time.perf_counter()
        HTTP_IN_FLIGHT.inc()
        tracer = get_tracer("timeflow.gateway")
        span = tracer.start_span(
            "http.request",
            kind=SpanKind.SERVER,
            attributes={"http.request.method": method},
        )
        token = otel_context.attach(set_span_in_context(span))

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except BaseException:
            span.set_status(Status(StatusCode.ERROR))
            raise
        finally:
            route = _route_template(scope)
            duration = time.perf_counter() - started
            HTTP_REQUESTS.labels(method, route, str(status_code)).inc()
            HTTP_DURATION.labels(method, route).observe(duration)
            span.set_attribute("http.route", route)
            span.set_attribute("http.response.status_code", status_code)
            if status_code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            span.end()
            otel_context.detach(token)
            HTTP_IN_FLIGHT.dec()


def _route_template(scope: Scope) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path in _KNOWN_ROUTES:
        return path
    raw = scope.get("path")
    if isinstance(raw, str) and raw in _KNOWN_ROUTES:
        return raw
    return "unmatched"


def create_metrics_router() -> APIRouter:
    """Expose the default Prometheus registry at GET /metrics."""
    router = APIRouter()

    @router.get("/metrics")
    def metrics(_request: Request) -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return router


def install_http_observability(application: FastAPI) -> None:
    """Attach HTTP metrics middleware and the scrape route."""
    application.add_middleware(HttpMetricsMiddleware)
    application.include_router(create_metrics_router())


__all__ = [
    "HttpMetricsMiddleware",
    "create_metrics_router",
    "install_http_observability",
    "record_auth_access",
    "record_health",
    "record_reminder_state",
    "record_schedule_snapshot",
]
