"""Tests for SQLAlchemy engine and session construction."""

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
        assert engine.hide_parameters is True

    engine.dispose()


def test_database_engine_hides_bound_parameters_in_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """SQL 日志不能输出账户标识、密码哈希或其他绑定参数。"""
    engine = build_engine("sqlite+pysqlite:///:memory:")
    username = "never-log-this-username"
    password_hash = "$argon2id$never-log-this-password-hash"

    with caplog.at_level(logging.INFO, logger="sqlalchemy.engine.Engine"):
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE secrets (username TEXT, password_hash TEXT)"))
            connection.execute(
                text(
                    "INSERT INTO secrets (username, password_hash) "
                    "VALUES (:username, :password_hash)"
                ),
                {"username": username, "password_hash": password_hash},
            )

    engine.dispose()
    assert username not in caplog.text
    assert password_hash not in caplog.text
    assert "SQL parameters hidden" in caplog.text
