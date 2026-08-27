"""SQLAlchemy primitives for persistence adapters."""

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from timeflow.infrastructure.observability.database import instrument_engine


class Base(DeclarativeBase):
    """Declarative base for TimeFlow-owned database models."""


def build_engine(database_url: str) -> Engine:
    """Create a database engine without opening a connection eagerly."""
    engine = create_engine(database_url, pool_pre_ping=True, hide_parameters=True)
    return instrument_engine(engine)


def ping_database(engine: Engine) -> bool:
    """Return whether the engine can execute a trivial readiness query."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create the session factory used by repository adapters."""
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
