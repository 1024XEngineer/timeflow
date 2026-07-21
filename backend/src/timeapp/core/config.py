"""Environment-backed application settings."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """从环境变量或本地 .env 文件加载运行时配置。"""

    app_name: str = "TimeApp"
    environment: str = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://timeapp:timeapp@127.0.0.1:5432/timeapp"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="TIMEAPP_",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """返回进程内复用的配置实例。"""

    return Settings()
