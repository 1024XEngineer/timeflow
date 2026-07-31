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
class AliyunTTSSettings:
    """Aliyun Qwen-Audio-TTS HTTP connection settings."""

    api_url: str
    api_key: str
    model: str
    voice: str
    audio_format: str
    sample_rate_hz: int
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration with development-safe defaults."""

    app_name: str
    environment: str
    database_url: str
    aliyun_asr: AliyunASRSettings
    aliyun_tts: AliyunTTSSettings
    openai: OpenAISettings
    reminder_audio_dir: Path

    @staticmethod
    def _get_env(name: str, default: str) -> str:
        value = environ.get(name, "").strip()
        return value or default

    @classmethod
    def from_environment(cls, env_file: Path | str = ".env") -> "Settings":
        """Load settings from TIMEFLOW-prefixed environment variables."""
        env_path = Path(env_file).expanduser().absolute()
        load_dotenv(dotenv_path=env_path, override=False)
        reminder_audio_dir = Path(
            cls._get_env("TIMEFLOW_REMINDER_AUDIO_DIR", ".data/reminder-audio")
        ).expanduser()
        if not reminder_audio_dir.is_absolute():
            reminder_audio_dir = env_path.parent / reminder_audio_dir
        reminder_audio_dir = reminder_audio_dir.absolute()
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
            aliyun_tts=AliyunTTSSettings(
                api_url=cls._get_env(
                    "TIMEFLOW_ALIYUN_TTS_API_URL",
                    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
                ),
                api_key=cls._get_env("TIMEFLOW_ALIYUN_TTS_API_KEY", ""),
                model=cls._get_env(
                    "TIMEFLOW_ALIYUN_TTS_MODEL",
                    "qwen-audio-3.0-tts-flash",
                ),
                voice=cls._get_env("TIMEFLOW_ALIYUN_TTS_VOICE", "longanhuan_v3.6"),
                audio_format=cls._get_env("TIMEFLOW_ALIYUN_TTS_FORMAT", "wav"),
                sample_rate_hz=int(
                    cls._get_env("TIMEFLOW_ALIYUN_TTS_SAMPLE_RATE_HZ", "24000")
                ),
                timeout_seconds=float(
                    cls._get_env("TIMEFLOW_ALIYUN_TTS_TIMEOUT_SECONDS", "30")
                ),
            ),
            openai=OpenAISettings(
                base_url=cls._get_env("TIMEFLOW_OPENAI_BASE_URL", "https://api.openai.com/v1"),
                api_key=cls._get_env("TIMEFLOW_OPENAI_API_KEY", ""),
                model=cls._get_env("TIMEFLOW_OPENAI_MODEL", "gpt-4.1-mini"),
            ),
            reminder_audio_dir=reminder_audio_dir,
        )


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
