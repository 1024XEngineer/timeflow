"""可丢弃 PostgreSQL 集成测试使用的共享 pytest fixture。"""

import os
from collections.abc import Iterator

import pytest
import sqlalchemy as sa
from auth_test_support import TEST_JWT_ENVIRONMENT
from sqlalchemy import Engine
from sqlalchemy.engine import Connection

_ORIGINAL_JWT_ENVIRONMENT = {name: os.environ.get(name) for name in TEST_JWT_ENVIRONMENT}
os.environ.update(TEST_JWT_ENVIRONMENT)


@pytest.fixture(scope="session", autouse=True)
def restore_jwt_environment_after_tests() -> Iterator[None]:
    """隔离测试会话结束后恢复调用方原有的 JWT 环境变量。"""
    yield
    for name, value in _ORIGINAL_JWT_ENVIRONMENT.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


@pytest.fixture(scope="session")
def postgres_engine() -> Iterator[Engine]:
    """仅在显式提供可丢弃集成数据库时建立连接。"""
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")
    engine = sa.create_engine(database_url, hide_parameters=True)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def postgres_connection(postgres_engine: Engine) -> Iterator[Connection]:
    """每个测试结束后回滚集成测试数据。"""
    with postgres_engine.connect() as connection:
        transaction = connection.begin()
        try:
            yield connection
        finally:
            transaction.rollback()
