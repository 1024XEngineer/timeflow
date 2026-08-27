"""Database engine instrumentation records bounded query kinds."""

from types import SimpleNamespace

from observability_support import metric_value
from sqlalchemy import create_engine, text

from timeflow.data.database import build_engine, ping_database
from timeflow.infrastructure.observability.database import _finish_query, instrument_engine


def test_build_engine_records_select_queries() -> None:
    before = metric_value("timeflow_db_queries_total", {"operation": "SELECT", "status": "ok"})
    engine = build_engine("sqlite+pysqlite:///:memory:")
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    engine.dispose()

    assert (
        metric_value("timeflow_db_queries_total", {"operation": "SELECT", "status": "ok"}) > before
    )


def test_ping_database_reports_a_reachable_sqlite_engine() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    try:
        assert ping_database(engine) is True
    finally:
        engine.dispose()


def test_ping_database_reports_an_unreachable_engine() -> None:
    engine = create_engine("postgresql+psycopg://timeapp:timeapp@127.0.0.1:1/timeapp")
    try:
        assert ping_database(engine) is False
    finally:
        engine.dispose()


def test_instrument_engine_is_idempotent_and_records_statement_errors() -> None:
    engine = build_engine("sqlite+pysqlite:///:memory:")
    instrument_engine(engine)
    before = metric_value("timeflow_db_queries_total", {"operation": "SELECT", "status": "error"})
    with engine.connect() as connection:
        try:
            connection.execute(text("SELECT * FROM timeflow_missing_relation"))
        except Exception:
            pass
    engine.dispose()

    assert (
        metric_value("timeflow_db_queries_total", {"operation": "SELECT", "status": "error"})
        > before
    )


def test_handle_error_without_execution_context_still_counts_the_statement() -> None:
    engine = build_engine("sqlite+pysqlite:///:memory:")
    before = metric_value("timeflow_db_queries_total", {"operation": "INSERT", "status": "error"})
    for listener in engine.dialect.dispatch.handle_error:
        listener(
            SimpleNamespace(execution_context=None, statement="INSERT INTO accounts VALUES (1)")
        )
    engine.dispose()

    assert (
        metric_value("timeflow_db_queries_total", {"operation": "INSERT", "status": "error"})
        == before + 1
    )


def test_invalidate_increments_the_pool_error_counter() -> None:
    engine = build_engine("sqlite+pysqlite:///:memory:")
    before = metric_value("timeflow_db_pool_errors_total", {"kind": "invalidate"})
    with engine.connect() as connection:
        connection.invalidate()
    engine.dispose()

    assert metric_value("timeflow_db_pool_errors_total", {"kind": "invalidate"}) == before + 1


def test_finish_query_is_idempotent_when_the_context_already_closed() -> None:
    before = metric_value("timeflow_db_queries_total", {"operation": "OTHER", "status": "ok"})
    context = SimpleNamespace(_timeflow_finished=True)
    _finish_query(context, "ok")
    assert (
        metric_value("timeflow_db_queries_total", {"operation": "OTHER", "status": "ok"}) == before
    )
