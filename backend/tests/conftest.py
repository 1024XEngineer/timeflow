"""Shared pytest fixtures for disposable PostgreSQL integration tests."""

import os
from collections.abc import Iterator

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.engine import Connection


@pytest.fixture(scope="session")
def postgres_engine() -> Iterator[Engine]:
    """Connect only when an explicit disposable integration database is supplied."""
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")
    engine = sa.create_engine(database_url)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def postgres_connection(postgres_engine: Engine) -> Iterator[Connection]:
    """Roll back integration-test data after each test."""
    with postgres_engine.connect() as connection:
        transaction = connection.begin()
        try:
            yield connection
        finally:
            transaction.rollback()
