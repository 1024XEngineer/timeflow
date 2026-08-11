"""Tests for SQLAlchemy engine and session construction."""

from sqlalchemy import text

from timeflow.data.database import build_engine, build_session_factory


def test_database_factories_build_working_session() -> None:
    engine = build_engine("sqlite+pysqlite:///:memory:")
    session_factory = build_session_factory(engine)

    with session_factory() as session:
        assert session.scalar(text("SELECT 1")) == 1
        assert session.autoflush is False
        assert session.expire_on_commit is False

    engine.dispose()
