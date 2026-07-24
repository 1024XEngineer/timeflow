"""Shared FastAPI dependencies."""

from collections.abc import Generator

from sqlalchemy.orm import Session

from timeapp.core.db import SessionLocal


def get_db() -> Generator[Session, None, None]:
    """提供一个请求范围内的数据库会话。"""

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
