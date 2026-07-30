"""Environment-backed application settings."""

from dataclasses import dataclass
from functools import lru_cache
from os import environ
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True, slots=True)
class AliyunASRSettings:
    """Aliyun Qwen-ASR realtime connection settings."""

    ws_url: str
    api_key: str
    model: str


@dataclass(frozen=True, slots=True)
class OpenAISettings:
    """OpenAI request client settings."""

    base_url: str
    api_key: str
    model: str


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration with development-safe defaults."""

    app_name: str
    environment: str
    database_url: str
    aliyun_asr: AliyunASRSettings
    openai: OpenAISettings

    @staticmethod
    def _get_env(name: str, default: str) -> str:
        value = environ.get(name, "").strip()
        return value or default

    @classmethod
    def from_environment(cls, env_file: Path | str = ".env") -> "Settings":
        """Load settings from TIMEFLOW-prefixed environment variables."""
        load_dotenv(dotenv_path=env_file, override=False)
        return cls(
            app_name=cls._get_env("TIMEFLOW_APP_NAME", "TimeFlow API"),
            environment=cls._get_env("TIMEFLOW_ENVIRONMENT", "development"),
            database_url=cls._get_env(
                "TIMEFLOW_DATABASE_URL",
                "postgresql+psycopg://timeapp:timeapp@127.0.0.1:5432/timeapp",
            ),
            aliyun_asr=AliyunASRSettings(
                ws_url=cls._get_env(
                    "TIMEFLOW_ALIYUN_ASR_WS_URL",
                    "wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
                ),
                api_key=cls._get_env("TIMEFLOW_ALIYUN_ASR_API_KEY", ""),
                model=cls._get_env(
                    "TIMEFLOW_ALIYUN_ASR_MODEL",
                    "qwen3-asr-flash-realtime-2026-02-10",
                ),
            ),
            openai=OpenAISettings(
                base_url=cls._get_env("TIMEFLOW_OPENAI_BASE_URL", "https://api.openai.com/v1"),
                api_key=cls._get_env("TIMEFLOW_OPENAI_API_KEY", ""),
                model=cls._get_env("TIMEFLOW_OPENAI_MODEL", "gpt-4.1-mini"),
            ),
        )


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
