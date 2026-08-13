"""SQLAlchemy primitives for persistence adapters."""

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    """Declarative base for TimeFlow-owned database models."""


def build_engine(database_url: str) -> Engine:
    """Create a database engine without opening a connection eagerly."""
    return create_engine(database_url, pool_pre_ping=True, hide_parameters=True)


def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create the session factory used by repository adapters."""
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
