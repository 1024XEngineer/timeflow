"""Settings behavior tests."""

from pathlib import Path

import pytest
from pytest import MonkeyPatch

from timeflow.infrastructure.security.access_token import JWT_ACCESS_TTL_SECONDS
from timeflow.infrastructure.settings import Settings, get_settings

ASR_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_ALIYUN_ASR_WS_URL",
    "TIMEFLOW_ALIYUN_ASR_API_KEY",
    "TIMEFLOW_ALIYUN_ASR_MODEL",
    "TIMEFLOW_ALIYUN_ASR_LANGUAGE",
    "TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD",
    "TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS",
    "TIMEFLOW_ALIYUN_ASR_CONNECT_TIMEOUT_SECONDS",
    "TIMEFLOW_ALIYUN_ASR_FINISH_TIMEOUT_SECONDS",
)
LLM_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_OPENAI_BASE_URL",
    "TIMEFLOW_OPENAI_API_KEY",
    "TIMEFLOW_OPENAI_MODEL",
    "TIMEFLOW_OPENAI_TIMEOUT_SECONDS",
    "TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS",
    "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS",
    "TIMEFLOW_VOICE_AGENT_MODE",
)
TTS_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_ALIYUN_TTS_WS_URL",
    "TIMEFLOW_ALIYUN_TTS_API_KEY",
    "TIMEFLOW_ALIYUN_TTS_MODEL",
    "TIMEFLOW_ALIYUN_TTS_VOICE",
    "TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS",
    "TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS",
)
AUDIO_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION",
    "TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD",
    "TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS",
    "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS",
    "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK",
)
JWT_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_JWT_SECRET",
    "TIMEFLOW_JWT_ISSUER",
    "TIMEFLOW_JWT_AUDIENCE",
    "TIMEFLOW_JWT_ACCESS_TTL_SECONDS",
)
CORS_ENVIRONMENT_VARIABLES = ("TIMEFLOW_CORS_ALLOWED_ORIGINS",)
OTEL_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_OTEL_SERVICE_NAME",
    "TIMEFLOW_OTEL_EXPORTER_OTLP_ENDPOINT",
    "TIMEFLOW_OTEL_TRACES_ENABLED",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
)
TENCENT_MAP_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_TENCENT_MAP_KEY",
    "TIMEFLOW_TENCENT_MAP_BASE_URL",
    "TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS",
)


def clear_asr_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove ASR variables so local environments do not affect assertions."""
    for name in ASR_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def clear_llm_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove LLM variables so local environments do not affect assertions."""
    for name in LLM_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def clear_tts_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove TTS variables so local environments do not affect assertions."""
    for name in TTS_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def clear_tencent_map_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove map variables so local credentials do not affect tests."""
    for name in TENCENT_MAP_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def clear_audio_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove end-to-end audio turn-detection variables so assertions are deterministic."""
    for name in AUDIO_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def clear_model_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove provider-specific variables before settings assertions."""
    clear_asr_environment(monkeypatch)
    clear_llm_environment(monkeypatch)
    clear_tts_environment(monkeypatch)
    clear_audio_environment(monkeypatch)
    for name in JWT_ENVIRONMENT_VARIABLES + CORS_ENVIRONMENT_VARIABLES + OTEL_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    clear_tencent_map_environment(monkeypatch)


def test_settings_use_timeflow_environment(monkeypatch: MonkeyPatch) -> None:
    """TIMEFLOW-prefixed variables override development defaults."""
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_APP_NAME", "Test API")
    monkeypatch.setenv("TIMEFLOW_ENVIRONMENT", "test")
    monkeypatch.setenv("TIMEFLOW_DATABASE_URL", "sqlite+pysqlite:///:memory:")
    get_settings.cache_clear()

    settings = Settings.from_environment()

    assert settings.app_name == "Test API"
    assert settings.environment == "test"
    assert settings.database_url == "sqlite+pysqlite:///:memory:"


def test_settings_load_dotenv_file(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    """A fresh clone can configure the backend through backend/.env."""
    clear_model_environment(monkeypatch)
    monkeypatch.delenv("TIMEFLOW_APP_NAME", raising=False)
    monkeypatch.delenv("TIMEFLOW_ENVIRONMENT", raising=False)
    monkeypatch.delenv("TIMEFLOW_DATABASE_URL", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "TIMEFLOW_APP_NAME=Dotenv API",
                "TIMEFLOW_ENVIRONMENT=dotenv-test",
                "TIMEFLOW_DATABASE_URL=sqlite+pysqlite:///:memory:",
            ]
        ),
        encoding="utf-8",
    )

    settings = Settings.from_environment(env_file)

    assert settings.app_name == "Dotenv API"
    assert settings.environment == "dotenv-test"
    assert settings.database_url == "sqlite+pysqlite:///:memory:"


def test_settings_use_qwen_asr_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.aliyun_asr_ws_url == ""
    assert settings.aliyun_asr_api_key == ""
    assert settings.aliyun_asr_model == "qwen3-asr-flash-realtime"
    assert settings.aliyun_asr_language == "zh"
    assert settings.aliyun_asr_vad_threshold == 0.6
    assert settings.aliyun_asr_vad_silence_duration_ms == 400
    assert settings.aliyun_asr_connect_timeout_seconds == 10.0
    assert settings.aliyun_asr_finish_timeout_seconds == 10.0


def test_settings_use_qwen_llm_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.openai_base_url == ""
    assert settings.openai_api_key == ""
    assert settings.openai_model == "qwen-flash"
    assert settings.openai_timeout_seconds == 30.0
    assert settings.schedule_category_timeout_seconds == 10.0
    assert settings.openai_is_configured() is False
    assert settings.agent_max_tool_rounds == 4
    assert settings.voice_agent_mode == "1"
    assert settings.otel_service_name == "timeflow-backend"
    assert settings.otel_exporter_otlp_endpoint == ""
    assert settings.otel_traces_enabled is False


def test_settings_enable_traces_when_otlp_endpoint_is_set(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo:4318")
    monkeypatch.setenv("TIMEFLOW_OTEL_SERVICE_NAME", "timeflow-test")

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.otel_exporter_otlp_endpoint == "http://tempo:4318"
    assert settings.otel_service_name == "timeflow-test"
    assert settings.otel_traces_enabled is True


def test_settings_honor_explicit_trace_disable_even_with_an_endpoint(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo:4318")
    monkeypatch.setenv("TIMEFLOW_OTEL_TRACES_ENABLED", "0")

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.otel_exporter_otlp_endpoint == "http://tempo:4318"
    assert settings.otel_traces_enabled is False


def test_settings_use_qwen_tts_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.aliyun_tts_ws_url == ""
    assert settings.aliyun_tts_api_key == ""
    assert settings.aliyun_tts_model == "qwen-audio-3.0-tts-flash"
    assert settings.aliyun_tts_voice == "longanhuan_v3.6"
    assert settings.aliyun_tts_connect_timeout_seconds == 10.0
    assert settings.aliyun_tts_task_timeout_seconds == 30.0


def test_settings_use_qwen_audio_turn_detection_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.aliyun_audio_turn_detection == "smart_turn"
    assert settings.aliyun_audio_vad_threshold == 0.5
    assert settings.aliyun_audio_vad_silence_duration_ms == 800
    assert settings.aliyun_audio_max_history_turns == 10
    assert settings.aliyun_audio_max_history_turns_push_to_talk == 5


def test_settings_convert_audio_turn_detection_environment_values(
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION", "server_vad")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD", "0.1")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS", "900")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS", "10")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK", "1")

    settings = Settings.from_environment()

    assert settings.aliyun_audio_turn_detection == "server_vad"
    assert settings.aliyun_audio_vad_threshold == 0.1
    assert settings.aliyun_audio_vad_silence_duration_ms == 900
    assert settings.aliyun_audio_max_history_turns == 10
    assert settings.aliyun_audio_max_history_turns_push_to_talk == 1


def test_settings_allow_empty_jwt_secret_with_v1_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    """工具无需构建真实认证组件也能读取配置。"""
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.jwt_secret == ""
    assert settings.jwt_issuer == "timeflow-api"
    assert settings.jwt_audience == "timeflow-app"
    assert settings.jwt_access_ttl_seconds == JWT_ACCESS_TTL_SECONDS


def test_settings_carry_explicit_jwt_environment_values(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    """配置层承载原始 JWT 参数，真实服务负责校验 v1 约束。"""
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_JWT_SECRET", "configured-secret")
    monkeypatch.setenv("TIMEFLOW_JWT_ISSUER", "another-issuer")
    monkeypatch.setenv("TIMEFLOW_JWT_AUDIENCE", "another-audience")
    monkeypatch.setenv("TIMEFLOW_JWT_ACCESS_TTL_SECONDS", "7200")

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.jwt_secret == "configured-secret"
    assert settings.jwt_issuer == "another-issuer"
    assert settings.jwt_audience == "another-audience"
    assert settings.jwt_access_ttl_seconds == 7200
    assert "configured-secret" not in repr(settings)


def test_settings_normalize_explicit_cors_origins(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv(
        "TIMEFLOW_CORS_ALLOWED_ORIGINS",
        " http://localhost:8081/,https://app.example.com,http://localhost:8081 ",
    )

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.cors_allowed_origins == (
        "http://localhost:8081",
        "https://app.example.com",
    )


def test_settings_convert_asr_environment_values(monkeypatch: MonkeyPatch) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_WS_URL", "wss://example.invalid/ws")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_API_KEY", "test-key")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_MODEL", "custom-model")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_LANGUAGE", "en")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD", "1.0")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS", "1000")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_CONNECT_TIMEOUT_SECONDS", "12.5")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_FINISH_TIMEOUT_SECONDS", "15")

    settings = Settings.from_environment()

    assert settings.aliyun_asr_ws_url == "wss://example.invalid/ws"
    assert settings.aliyun_asr_api_key == "test-key"
    assert settings.aliyun_asr_model == "custom-model"
    assert settings.aliyun_asr_language == "en"
    assert settings.aliyun_asr_vad_threshold == 1.0
    assert settings.aliyun_asr_vad_silence_duration_ms == 1000
    assert settings.aliyun_asr_connect_timeout_seconds == 12.5
    assert settings.aliyun_asr_finish_timeout_seconds == 15.0


def test_settings_convert_llm_environment_values(monkeypatch: MonkeyPatch) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_OPENAI_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("TIMEFLOW_OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("TIMEFLOW_OPENAI_MODEL", "custom-model")
    monkeypatch.setenv("TIMEFLOW_OPENAI_TIMEOUT_SECONDS", "12.5")
    monkeypatch.setenv("TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS", "4.5")
    monkeypatch.setenv("TIMEFLOW_AGENT_MAX_TOOL_ROUNDS", "6")
    monkeypatch.setenv("TIMEFLOW_VOICE_AGENT_MODE", "2")

    settings = Settings.from_environment()

    assert settings.openai_base_url == "https://example.invalid/v1"
    assert settings.openai_api_key == "test-key"
    assert settings.openai_model == "custom-model"
    assert settings.openai_timeout_seconds == 12.5
    assert settings.schedule_category_timeout_seconds == 4.5
    assert settings.openai_is_configured() is True
    assert settings.agent_max_tool_rounds == 6
    assert settings.voice_agent_mode == "2"


def test_settings_convert_tts_environment_values(monkeypatch: MonkeyPatch) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_WS_URL", "wss://example.invalid/inference")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_API_KEY", "test-key")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_MODEL", "custom-tts")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_VOICE", "custom-voice")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS", "8.5")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS", "20")

    settings = Settings.from_environment()

    assert settings.aliyun_tts_ws_url == "wss://example.invalid/inference"
    assert settings.aliyun_tts_api_key == "test-key"
    assert settings.aliyun_tts_model == "custom-tts"
    assert settings.aliyun_tts_voice == "custom-voice"
    assert settings.aliyun_tts_connect_timeout_seconds == 8.5
    assert settings.aliyun_tts_task_timeout_seconds == 20.0


def test_settings_use_tencent_map_defaults(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    clear_model_environment(monkeypatch)

    settings = Settings.from_environment(tmp_path / "missing.env")

    assert settings.tencent_map_api_key == ""
    assert settings.tencent_map_base_url == "https://apis.map.qq.com"
    assert settings.tencent_map_timeout_seconds == 5.0
    assert settings.tencent_maps_is_configured() is False


def test_settings_convert_tencent_map_environment_values(monkeypatch: MonkeyPatch) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_TENCENT_MAP_KEY", " test-map-key ")
    monkeypatch.setenv("TIMEFLOW_TENCENT_MAP_BASE_URL", " https://maps.example.test ")
    monkeypatch.setenv("TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS", "7.5")

    settings = Settings.from_environment()

    assert settings.tencent_map_api_key == "test-map-key"
    assert settings.tencent_map_base_url == "https://maps.example.test"
    assert settings.tencent_map_timeout_seconds == 7.5
    assert settings.tencent_maps_is_configured() is True


@pytest.mark.parametrize(
    "value",
    [
        "http://apis.map.qq.com",
        "https://",
        "https://user:password@apis.map.qq.com",
        "https://apis.map.qq.com?key=secret",
        "https://apis.map.qq.com#fragment",
    ],
)
def test_settings_reject_invalid_tencent_map_base_url(monkeypatch: MonkeyPatch, value: str) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_TENCENT_MAP_BASE_URL", value)

    with pytest.raises(ValueError, match="credential-free HTTPS URL"):
        Settings.from_environment()


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf"])
def test_settings_reject_invalid_tencent_map_timeout(monkeypatch: MonkeyPatch, value: str) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv("TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS", value)

    with pytest.raises(ValueError, match="TIMEFLOW_TENCENT_MAP_TIMEOUT_SECONDS"):
        Settings.from_environment()


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        (
            "TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD",
            "1.5",
            "TIMEFLOW_ALIYUN_ASR_VAD_THRESHOLD must be between -1 and 1",
        ),
        (
            "TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS",
            "100",
            "TIMEFLOW_ALIYUN_ASR_VAD_SILENCE_DURATION_MS must be between 200 and 6000",
        ),
        (
            "TIMEFLOW_ALIYUN_ASR_CONNECT_TIMEOUT_SECONDS",
            "0",
            "ASR timeouts must be greater than zero",
        ),
        (
            "TIMEFLOW_ALIYUN_ASR_FINISH_TIMEOUT_SECONDS",
            "-1",
            "ASR timeouts must be greater than zero",
        ),
        (
            "TIMEFLOW_OPENAI_TIMEOUT_SECONDS",
            "0",
            "TIMEFLOW_OPENAI_TIMEOUT_SECONDS must be greater than zero",
        ),
        (
            "TIMEFLOW_OPENAI_TIMEOUT_SECONDS",
            "-1",
            "TIMEFLOW_OPENAI_TIMEOUT_SECONDS must be greater than zero",
        ),
        (
            "TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS",
            "0",
            "TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS must be greater than zero",
        ),
        (
            "TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS",
            "nan",
            "TIMEFLOW_SCHEDULE_CATEGORY_TIMEOUT_SECONDS must be greater than zero",
        ),
        (
            "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS",
            "0",
            "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS must be a positive integer",
        ),
        (
            "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS",
            "-1",
            "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS must be a positive integer",
        ),
        (
            "TIMEFLOW_VOICE_AGENT_MODE",
            "3",
            "TIMEFLOW_VOICE_AGENT_MODE must be '1' or '2'",
        ),
        (
            "TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS",
            "0",
            "TTS timeouts must be greater than zero",
        ),
        (
            "TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS",
            "-1",
            "TTS timeouts must be greater than zero",
        ),
        (
            "TIMEFLOW_CORS_ALLOWED_ORIGINS",
            "*",
            r"TIMEFLOW_CORS_ALLOWED_ORIGINS must contain only explicit HTTP\(S\) origins",
        ),
        (
            "TIMEFLOW_CORS_ALLOWED_ORIGINS",
            "https://app.example.com/path",
            r"TIMEFLOW_CORS_ALLOWED_ORIGINS must contain only explicit HTTP\(S\) origins",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION",
            "push_to_talk",
            "TIMEFLOW_ALIYUN_AUDIO_TURN_DETECTION must be 'smart_turn' or 'server_vad'",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD",
            "1.5",
            "TIMEFLOW_ALIYUN_AUDIO_VAD_THRESHOLD must be between -1 and 1",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS",
            "100",
            "TIMEFLOW_ALIYUN_AUDIO_VAD_SILENCE_DURATION_MS must be between 200 and 6000",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS",
            "0",
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS must be between 1 and 50",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS",
            "51",
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS must be between 1 and 50",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK",
            "0",
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK must be between 1 and 50",
        ),
        (
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK",
            "51",
            "TIMEFLOW_ALIYUN_AUDIO_MAX_HISTORY_TURNS_PUSH_TO_TALK must be between 1 and 50",
        ),
    ],
)
def test_settings_reject_invalid_values(
    monkeypatch: MonkeyPatch, name: str, value: str, message: str
) -> None:
    clear_model_environment(monkeypatch)
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        Settings.from_environment()
