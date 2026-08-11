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
    aliyun_asr_ws_url: str = ""
    aliyun_asr_api_key: str = ""
    aliyun_asr_model: str = "qwen3-asr-flash-realtime"
    aliyun_asr_language: str = "zh"
    aliyun_asr_vad_threshold: float = 0.0
    aliyun_asr_vad_silence_duration_ms: int = 400
    aliyun_asr_connect_timeout_seconds: float = 10.0
    aliyun_asr_finish_timeout_seconds: float = 10.0

    @classmethod
    def from_environment(cls, env_file: Path | str = ".env") -> "Settings":
        """Load settings from TIMEFLOW-prefixed environment variables."""
        load_dotenv(dotenv_path=env_file, override=False)

        aliyun_asr_vad_threshold = float(environ.get("TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD", "0.0"))
        aliyun_asr_vad_silence_duration_ms = int(
            environ.get("TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS", "400")
        )
        aliyun_asr_connect_timeout_seconds = float(
            environ.get("TIMEFLOW_ALIYUN_ASR_CONNECT_TIMEOUT_SECONDS", "10.0")
        )
        aliyun_asr_finish_timeout_seconds = float(
            environ.get("TIMEFLOW_ALIYUN_ASR_FINISH_TIMEOUT_SECONDS", "10.0")
        )

        if not -1.0 <= aliyun_asr_vad_threshold <= 1.0:
            raise ValueError("TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD must be between -1 and 1")
        if not 200 <= aliyun_asr_vad_silence_duration_ms <= 6000:
            raise ValueError(
                "TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS must be between 200 and 6000"
            )
        if aliyun_asr_connect_timeout_seconds <= 0 or aliyun_asr_finish_timeout_seconds <= 0:
            raise ValueError("ASR timeouts must be greater than zero")

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
            aliyun_asr_ws_url=environ.get("TIMEFLOW_ALIYUN_ASR_WS_URL", ""),
            aliyun_asr_api_key=environ.get("TIMEFLOW_ALIYUN_ASR_API_KEY", ""),
            aliyun_asr_model=environ.get(
                "TIMEFLOW_ALIYUN_ASR_MODEL",
                "qwen3-asr-flash-realtime",
            ),
            aliyun_asr_language=environ.get("TIMEFLOW_ALIYUN_ASR_LANGUAGE", "zh"),
            aliyun_asr_vad_threshold=aliyun_asr_vad_threshold,
            aliyun_asr_vad_silence_duration_ms=aliyun_asr_vad_silence_duration_ms,
            aliyun_asr_connect_timeout_seconds=aliyun_asr_connect_timeout_seconds,
            aliyun_asr_finish_timeout_seconds=aliyun_asr_finish_timeout_seconds,
        )


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
