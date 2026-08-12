"""SQLAlchemy 引擎和会话构建测试。"""

import logging

import pytest
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


def test_database_engine_hides_sensitive_sql_parameters(
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = build_engine("sqlite+pysqlite:///:memory:")
    password = "never-log-this-password"
    password_hash = "$argon2id$never-log-this-hash"

    with caplog.at_level(logging.INFO, logger="sqlalchemy.engine.Engine"):
        with engine.connect() as connection:
            connection.execute(
                text("SELECT :password, :password_hash"),
                {"password": password, "password_hash": password_hash},
            )

    assert engine.hide_parameters is True
    assert password not in caplog.text
    assert password_hash not in caplog.text
    engine.dispose()
