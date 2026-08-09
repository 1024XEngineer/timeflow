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
    ws_handshake_timeout_seconds: float
    ws_max_unauthenticated_connections: int
    ws_audio_queue_max_chunks: int
    ws_max_audio_duration_ms: int
    ws_audio_chunk_size_bytes: int

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
            ws_handshake_timeout_seconds=float(
                environ.get("TIMEFLOW_WS_HANDSHAKE_TIMEOUT_SECONDS", "5.0")
            ),
            ws_max_unauthenticated_connections=int(
                environ.get("TIMEFLOW_WS_MAX_UNAUTHENTICATED_CONNECTIONS", "100")
            ),
            ws_audio_queue_max_chunks=int(environ.get("TIMEFLOW_WS_AUDIO_QUEUE_MAX_CHUNKS", "32")),
            ws_max_audio_duration_ms=int(
                environ.get("TIMEFLOW_WS_MAX_AUDIO_DURATION_MS", "120000")
            ),
            ws_audio_chunk_size_bytes=int(
                environ.get("TIMEFLOW_WS_AUDIO_CHUNK_SIZE_BYTES", "65536")
            ),
        )


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
