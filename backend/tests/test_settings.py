"""Settings behavior tests."""

from pathlib import Path

import pytest
from pytest import MonkeyPatch

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
    "TIMEFLOW_AGENT_MAX_TOOL_ROUNDS",
)
TTS_ENVIRONMENT_VARIABLES = (
    "TIMEFLOW_ALIYUN_TTS_WS_URL",
    "TIMEFLOW_ALIYUN_TTS_API_KEY",
    "TIMEFLOW_ALIYUN_TTS_MODEL",
    "TIMEFLOW_ALIYUN_TTS_VOICE",
    "TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS",
    "TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS",
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


def clear_model_environment(monkeypatch: MonkeyPatch) -> None:
    """Remove model-specific variables before settings assertions."""
    clear_asr_environment(monkeypatch)
    clear_llm_environment(monkeypatch)
    clear_tts_environment(monkeypatch)


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
    assert settings.aliyun_asr_vad_threshold == 0.0
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
    assert settings.agent_max_tool_rounds == 4


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
    monkeypatch.setenv("TIMEFLOW_AGENT_MAX_TOOL_ROUNDS", "6")

    settings = Settings.from_environment()

    assert settings.openai_base_url == "https://example.invalid/v1"
    assert settings.openai_api_key == "test-key"
    assert settings.openai_model == "custom-model"
    assert settings.openai_timeout_seconds == 12.5
    assert settings.agent_max_tool_rounds == 6


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
            "TIMEFLOW_ALIYUN_TTS_CONNECT_TIMEOUT_SECONDS",
            "0",
            "TTS timeouts must be greater than zero",
        ),
        (
            "TIMEFLOW_ALIYUN_TTS_TASK_TIMEOUT_SECONDS",
            "-1",
            "TTS timeouts must be greater than zero",
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
