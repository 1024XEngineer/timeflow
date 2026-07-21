"""Alembic 运行环境：从 Settings 读取库连接，并对齐 SQLAlchemy Base.metadata。"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from timeapp.core.config import get_settings
from timeapp.core.db import Base

# 新增 ORM 模型后在此导入，确保 metadata 注册进 autogenerate。
# 例：from timeapp.basic.timeline import models as timeline_models

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_database_url() -> str:
    """使用应用 Settings 中的数据库 URL，避免在 ini 中硬编码密钥。"""

    return get_settings().database_url


def run_migrations_offline() -> None:
    """离线模式：只输出 SQL，不实际连接数据库。"""

    context.configure(
        url=get_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连接数据库并执行迁移。"""

    connectable = create_engine(get_database_url(), poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
