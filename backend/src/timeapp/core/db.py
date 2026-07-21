"""SQLAlchemy engine, session and declarative base."""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from timeapp.core.config import get_settings


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
