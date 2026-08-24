"""SQLAlchemy engine instrumentation for pool and query metrics."""

from __future__ import annotations

import time
from typing import Any
from weakref import WeakSet

from opentelemetry import context as otel_context
from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context
from sqlalchemy import Engine, event
from sqlalchemy.engine import ExecutionContext
from sqlalchemy.pool import ConnectionPoolEntry

from timeflow.infrastructure.observability.metrics import (
    DB_POOL_CHECKED_OUT,
    DB_POOL_ERRORS,
    DB_POOL_SIZE,
    DB_QUERIES,
    DB_QUERY_DURATION,
    bound_db_operation,
    bound_status,
)
from timeflow.infrastructure.observability.tracing import get_tracer

_instrumented: WeakSet[Engine] = WeakSet()


def instrument_engine(engine: Engine) -> Engine:
    """Attach query and pool listeners. Safe to call once per engine."""
    if engine in _instrumented:
        return engine
    _instrumented.add(engine)

    @event.listens_for(engine, "before_cursor_execute")
    def _before_cursor_execute(
        conn: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: ExecutionContext,
        executemany: bool,
    ) -> None:
        del conn, cursor, parameters, executemany
        operation = bound_db_operation(statement)
        context._timeflow_query_started = time.perf_counter()  # type: ignore[attr-defined]
        span = get_tracer("timeflow.db").start_span(
            f"db.{operation.lower()}",
            kind=SpanKind.CLIENT,
            attributes={"timeflow.db.operation": operation},
        )
        context._timeflow_span = span  # type: ignore[attr-defined]
        context._timeflow_token = otel_context.attach(set_span_in_context(span))  # type: ignore[attr-defined]
        context._timeflow_operation = operation  # type: ignore[attr-defined]
        context._timeflow_finished = False  # type: ignore[attr-defined]

    @event.listens_for(engine, "after_cursor_execute")
    def _after_cursor_execute(
        conn: Any,
        cursor: Any,
        statement: str,
        parameters: Any,
        context: ExecutionContext,
        executemany: bool,
    ) -> None:
        del conn, cursor, statement, parameters, executemany
        _finish_query(context, "ok")

    @event.listens_for(engine, "handle_error")
    def _handle_error(exception_context: Any) -> None:
        execution_context = getattr(exception_context, "execution_context", None)
        if execution_context is not None:
            _finish_query(execution_context, "error")
        else:
            statement = getattr(exception_context, "statement", "") or ""
            _record_query(bound_db_operation(statement), "error", 0.0)
        DB_POOL_ERRORS.labels("query").inc()

    @event.listens_for(engine, "checkout")
    def _checkout(
        dbapi_connection: Any, connection_record: ConnectionPoolEntry, connection_proxy: Any
    ) -> None:
        del dbapi_connection, connection_record, connection_proxy
        _refresh_pool(engine)

    @event.listens_for(engine, "checkin")
    def _checkin(dbapi_connection: Any, connection_record: ConnectionPoolEntry) -> None:
        del dbapi_connection, connection_record
        _refresh_pool(engine)

    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection: Any, connection_record: ConnectionPoolEntry) -> None:
        del dbapi_connection, connection_record
        _refresh_pool(engine)

    @event.listens_for(engine, "invalidate")
    def _invalidate(
        dbapi_connection: Any,
        connection_record: ConnectionPoolEntry,
        exception: BaseException | None,
    ) -> None:
        del dbapi_connection, connection_record, exception
        DB_POOL_ERRORS.labels("invalidate").inc()
        _refresh_pool(engine)

    return engine


def _finish_query(context: ExecutionContext, status: str) -> None:
    if getattr(context, "_timeflow_finished", False):
        return
    context._timeflow_finished = True  # type: ignore[attr-defined]
    started = getattr(context, "_timeflow_query_started", None)
    duration = 0.0 if started is None else time.perf_counter() - float(started)
    operation = str(getattr(context, "_timeflow_operation", "OTHER"))
    span = getattr(context, "_timeflow_span", None)
    token = getattr(context, "_timeflow_token", None)
    if span is not None:
        span.set_attribute("timeflow.status", bound_status(status))
        span.set_attribute("timeflow.duration_ms", round(duration * 1000, 1))
        if status != "ok":
            span.set_status(Status(StatusCode.ERROR))
        span.end()
    if token is not None:
        otel_context.detach(token)
    _record_query(operation, status, duration)


def _record_query(operation: str, status: str, duration: float) -> None:
    status_label = bound_status(status)
    DB_QUERIES.labels(operation, status_label).inc()
    DB_QUERY_DURATION.labels(operation, status_label).observe(duration)


def _refresh_pool(engine: Engine) -> None:
    pool = engine.pool
    size = getattr(pool, "size", None)
    checked_out = getattr(pool, "checkedout", None)
    if callable(size):
        DB_POOL_SIZE.set(size())
    if callable(checked_out):
        DB_POOL_CHECKED_OUT.set(checked_out())


__all__ = ["instrument_engine"]
