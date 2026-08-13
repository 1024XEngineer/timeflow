"""Environment-backed application settings."""

import math
from dataclasses import dataclass, field
from functools import lru_cache
from os import environ
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

from timeflow.infrastructure.security.access_token import (
    JWT_ACCESS_TTL_SECONDS,
    JWT_AUDIENCE,
    JWT_ISSUER,
)


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
    cors_allowed_origins: tuple[str, ...] = ()
    ws_max_continuous_audio_duration_ms: int = 1_800_000
    jwt_secret: str = field(default="", repr=False)
    jwt_issuer: str = JWT_ISSUER
    jwt_audience: str = JWT_AUDIENCE
    jwt_access_ttl_seconds: int = JWT_ACCESS_TTL_SECONDS
    aliyun_asr_ws_url: str = ""
    aliyun_asr_api_key: str = ""
    aliyun_asr_model: str = "qwen3-asr-flash-realtime"
    aliyun_asr_language: str = "zh"
    aliyun_asr_vad_threshold: float = 0.0
    aliyun_asr_vad_silence_duration_ms: int = 400
    aliyun_asr_connect_timeout_seconds: float = 10.0
    aliyun_asr_finish_timeout_seconds: float = 10.0
    openai_base_url: str = ""
    openai_api_key: str = ""
    openai_model: str = "qwen-flash"
    openai_timeout_seconds: float = 30.0
    agent_max_tool_rounds: int = 4
    aliyun_tts_ws_url: str = ""
    aliyun_tts_api_key: str = ""
    aliyun_tts_model: str = "qwen-audio-3.0-tts-flash"
    aliyun_tts_voice: str = "longanhuan_v3.6"
    aliyun_tts_connect_timeout_seconds: float = 10.0
    aliyun_tts_task_timeout_seconds: float = 30.0
    # Named beside aliyun_asr_* rather than realtime_*: both are Aliyun realtime services,
    # so "realtime" alone does not say which. This one takes audio in and gives speech back.
    aliyun_audio_api_key: str = ""
    aliyun_audio_workspace_id: str = ""
    aliyun_audio_model: str = "qwen-audio-3.0-realtime-plus"
    aliyun_audio_region: str = "cn-beijing"
    aliyun_audio_voice: str = "longanqian"
    tencent_map_api_key: str = ""
    tencent_map_base_url: str = "https://apis.map.qq.com"
    tencent_map_timeout_seconds: float = 5.0
    # What continuous mode uses server-side; push-to-talk never touches this. Client
    # picks push_to_talk vs continuous -- which vendor VAD backs continuous is ours to tune.
    aliyun_audio_turn_detection: str = "smart_turn"
    aliyun_audio_vad_threshold: float = 0.5
    aliyun_audio_vad_silence_duration_ms: int = 800
    # "1" = the end-to-end realtime model; "2" = the LLM+ASR+TTS conversation pipeline.
    voice_agent_mode: str = "1"

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

        openai_timeout_seconds = float(environ.get("TIMEFLOW_OPENAI_TIMEOUT_SECONDS", "30.0"))
        agent_max_tool_rounds = int(environ.get("TIMEFLOW_AGENT_MAX_TOOL_ROUNDS", "4"))
        tencent_map_timeout_seconds = float(
            environ.get("TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS", "5.0")
        )
        tencent_map_base_url = environ.get(
            "TIMEFLOW_TENCENT_MAP_BASE_URL", "https://apis.map.qq.com"
        ).strip()
        voice_agent_mode = environ.get("TIMEFLOW_VOICE_AGENT_MODE", "1")
        aliyun_tts_connect_timeout_seconds = float(
            environ.get("TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS", "10.0")
        )
        aliyun_tts_task_timeout_seconds = float(
            environ.get("TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS", "30.0")
        )
        aliyun_audio_turn_detection = environ.get(
            "TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION", "smart_turn"
        )
        aliyun_audio_vad_threshold = float(
            environ.get("TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD", "0.5")
        )
        aliyun_audio_vad_silence_duration_ms = int(
            environ.get("TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS", "800")
        )

        if not -1.0 <= aliyun_asr_vad_threshold <= 1.0:
            raise ValueError("TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD must be between -1 and 1")
        if not 200 <= aliyun_asr_vad_silence_duration_ms <= 6000:
            raise ValueError(
                "TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS must be between 200 and 6000"
            )
        if aliyun_asr_connect_timeout_seconds <= 0 or aliyun_asr_finish_timeout_seconds <= 0:
            raise ValueError("ASR timeouts must be greater than zero")
        if openai_timeout_seconds <= 0:
            raise ValueError("TIMEFLOW_OPENAI_TIMEOUT_SECONDS must be greater than zero")
        if agent_max_tool_rounds <= 0:
            raise ValueError("TIMEFLOW_AGENT_MAX_TOOL_ROUNDS must be a positive integer")
        if voice_agent_mode not in ("1", "2"):
            raise ValueError("TIMEFLOW_VOICE_AGENT_MODE must be '1' or '2'")
        if aliyun_tts_connect_timeout_seconds <= 0 or aliyun_tts_task_timeout_seconds <= 0:
            raise ValueError("TTS timeouts must be greater than zero")
        if not math.isfinite(tencent_map_timeout_seconds) or tencent_map_timeout_seconds <= 0:
            raise ValueError("TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS must be greater than zero")
        _validate_tencent_map_base_url(tencent_map_base_url)
        if aliyun_audio_turn_detection not in ("smart_turn", "server_vad"):
            raise ValueError(
                "TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION must be 'smart_turn' or 'server_vad'"
            )
        if not -1.0 <= aliyun_audio_vad_threshold <= 1.0:
            raise ValueError("TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD must be between -1 and 1")
        if not 200 <= aliyun_audio_vad_silence_duration_ms <= 6000:
            raise ValueError(
                "TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS must be between 200 and 6000"
            )

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
            cors_allowed_origins=_parse_cors_allowed_origins(
                environ.get("TIMEFLOW_CORS_ALLOWED_ORIGINS", "")
            ),
            ws_max_continuous_audio_duration_ms=int(
                environ.get("TIMEFLOW_WS_MAX_CONTINUOUS_AUDIO_DURATION_MS", "1800000")
            ),
            jwt_secret=environ.get("TIMEFLOW_JWT_SECRET", ""),
            jwt_issuer=environ.get("TIMEFLOW_JWT_ISSUER", JWT_ISSUER),
            jwt_audience=environ.get("TIMEFLOW_JWT_AUDIENCE", JWT_AUDIENCE),
            jwt_access_ttl_seconds=int(
                environ.get("TIMEFLOW_JWT_ACCESS_TTL_SECONDS", str(JWT_ACCESS_TTL_SECONDS))
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
            openai_base_url=environ.get("TIMEFLOW_OPENAI_BASE_URL", ""),
            openai_api_key=environ.get("TIMEFLOW_OPENAI_API_KEY", ""),
            openai_model=environ.get("TIMEFLOW_OPENAI_MODEL", "qwen-flash"),
            openai_timeout_seconds=openai_timeout_seconds,
            agent_max_tool_rounds=agent_max_tool_rounds,
            aliyun_tts_ws_url=environ.get("TIMEFLOW_ALIYUN_TTS_WS_URL", ""),
            aliyun_tts_api_key=environ.get("TIMEFLOW_ALIYUN_TTS_API_KEY", ""),
            aliyun_tts_model=environ.get("TIMEFLOW_ALIYUN_TTS_MODEL", "qwen-audio-3.0-tts-flash"),
            aliyun_tts_voice=environ.get("TIMEFLOW_ALIYUN_TTS_VOICE", "longanhuan_v3.6"),
            aliyun_tts_connect_timeout_seconds=aliyun_tts_connect_timeout_seconds,
            aliyun_tts_task_timeout_seconds=aliyun_tts_task_timeout_seconds,
            aliyun_audio_api_key=environ.get("TIMEFLOW_ALIYUN_AUDIO_API_KEY", ""),
            aliyun_audio_workspace_id=environ.get("TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID", ""),
            aliyun_audio_model=environ.get(
                "TIMEFLOW_ALIYUN_AUDIO_MODEL",
                "qwen-audio-3.0-realtime-plus",
            ),
            aliyun_audio_region=environ.get("TIMEFLOW_ALIYUN_AUDIO_REGION", "cn-beijing"),
            aliyun_audio_voice=environ.get("TIMEFLOW_ALIYUN_AUDIO_VOICE", "longanqian"),
            tencent_map_api_key=environ.get("TIMEFLOW_TENCENT_MAP_KEY", "").strip(),
            tencent_map_base_url=tencent_map_base_url,
            tencent_map_timeout_seconds=tencent_map_timeout_seconds,
            aliyun_audio_turn_detection=aliyun_audio_turn_detection,
            aliyun_audio_vad_threshold=aliyun_audio_vad_threshold,
            aliyun_audio_vad_silence_duration_ms=aliyun_audio_vad_silence_duration_ms,
            voice_agent_mode=voice_agent_mode,
        )

    def aliyun_audio_is_configured(self) -> bool:
        """Report whether the end-to-end audio model can be reached.

        Only the two secrets are checked: the rest have working defaults, so a deployment
        that sets just these gets a working model rather than a puzzling half-configured one.
        """
        return bool(self.aliyun_audio_api_key and self.aliyun_audio_workspace_id)

    def tencent_maps_is_configured(self) -> bool:
        """Report whether the Tencent Maps adapter has a WebService credential."""
        return bool(self.tencent_map_api_key)


def _validate_tencent_map_base_url(value: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("TIMEFLOW_TENCENT_MAP_BASE_URL must be a credential-free HTTPS URL")


def _parse_cors_allowed_origins(raw_value: str) -> tuple[str, ...]:
    """规范化明确的 HTTP(S) 来源，并拒绝通配符与带路径的配置。"""
    origins: list[str] = []
    for item in raw_value.split(","):
        origin = item.strip().rstrip("/")
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (
            origin == "*"
            or parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "TIMEFLOW_CORS_ALLOWED_ORIGINS must contain only explicit HTTP(S) origins"
            )
        if origin not in origins:
            origins.append(origin)
    return tuple(origins)


@lru_cache
def get_settings() -> Settings:
    """Return immutable process settings."""
    return Settings.from_environment()
