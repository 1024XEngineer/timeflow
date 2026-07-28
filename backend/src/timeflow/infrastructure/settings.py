"""Environment-backed application settings."""

from dataclasses import dataclass
from functools import lru_cache
from os import environ
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration with development-safe defaults."""

    app_name: str
    environment: str
    database_url: str

    @classmethod
    def from_environment(cls, env_file: Path | str = ".env") -> "Settings":
        """Load settings from TIMEFLOW-prefixed environment variables."""
        load_dotenv(dotenv_path=env_file, override=False)
        return cls(
            app_name=environ.get("TIMEFLOW_APP_NAME", "TimeFlow API"),
            environment=environ.get("TIMEFLOW_ENVIRONMENT", "development"),
            database_url=environ.get(
                "TIMEFLOW_DATABASE_URL",
                "postgresql+psycopg://timeapp:timeapp@127.0.0.1:5432/timeapp",
            ),
        )


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
