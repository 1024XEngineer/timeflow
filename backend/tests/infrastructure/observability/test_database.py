"""Database engine instrumentation records bounded query kinds."""

from observability_support import metric_value
from sqlalchemy import create_engine, text

from timeflow.data.database import build_engine, ping_database
from timeflow.infrastructure.observability.database import instrument_engine


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
