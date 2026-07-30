"""Settings behavior tests."""

from pathlib import Path

from pytest import MonkeyPatch

from timeflow.infrastructure.settings import Settings, get_settings


def test_settings_use_timeflow_environment(monkeypatch: MonkeyPatch) -> None:
    """TIMEFLOW-prefixed variables override development defaults."""
    monkeypatch.setenv("TIMEFLOW_APP_NAME", "Test API")
    monkeypatch.setenv("TIMEFLOW_ENVIRONMENT", "test")
    monkeypatch.setenv("TIMEFLOW_DATABASE_URL", "sqlite+pysqlite:///:memory:")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_WS_URL", "wss://asr.example.test")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_API_KEY", "asr-key")
    monkeypatch.setenv("TIMEFLOW_ALIYUN_ASR_MODEL", "qwen-asr-realtime")
    monkeypatch.setenv("TIMEFLOW_OPENAI_BASE_URL", "https://llm.example.test/v1")
    monkeypatch.setenv("TIMEFLOW_OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("TIMEFLOW_OPENAI_MODEL", "gpt-test")
    get_settings.cache_clear()

    settings = Settings.from_environment()

    assert settings.app_name == "Test API"
    assert settings.environment == "test"
    assert settings.database_url == "sqlite+pysqlite:///:memory:"
    assert settings.aliyun_asr.ws_url == "wss://asr.example.test"
    assert settings.aliyun_asr.api_key == "asr-key"
    assert settings.aliyun_asr.model == "qwen-asr-realtime"
    assert settings.openai.base_url == "https://llm.example.test/v1"
    assert settings.openai.api_key == "openai-key"
    assert settings.openai.model == "gpt-test"


def test_settings_load_dotenv_file(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    """A fresh clone can configure the backend through backend/.env."""
    monkeypatch.delenv("TIMEFLOW_APP_NAME", raising=False)
    monkeypatch.delenv("TIMEFLOW_ENVIRONMENT", raising=False)
    monkeypatch.delenv("TIMEFLOW_DATABASE_URL", raising=False)
    monkeypatch.delenv("TIMEFLOW_ALIYUN_ASR_WS_URL", raising=False)
    monkeypatch.delenv("TIMEFLOW_ALIYUN_ASR_API_KEY", raising=False)
    monkeypatch.delenv("TIMEFLOW_ALIYUN_ASR_MODEL", raising=False)
    monkeypatch.delenv("TIMEFLOW_OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("TIMEFLOW_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("TIMEFLOW_OPENAI_MODEL", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "TIMEFLOW_APP_NAME=Dotenv API",
                "TIMEFLOW_ENVIRONMENT=dotenv-test",
                "TIMEFLOW_DATABASE_URL=sqlite+pysqlite:///:memory:",
                "TIMEFLOW_ALIYUN_ASR_API_KEY=dotenv-asr-key",
                "TIMEFLOW_OPENAI_API_KEY=dotenv-openai-key",
            ]
        ),
        encoding="utf-8",
    )

    settings = Settings.from_environment(env_file)

    assert settings.app_name == "Dotenv API"
    assert settings.environment == "dotenv-test"
    assert settings.database_url == "sqlite+pysqlite:///:memory:"
    assert settings.aliyun_asr.api_key == "dotenv-asr-key"
    assert settings.aliyun_asr.model == "qwen3-asr-flash-realtime-2026-02-10"
    assert settings.openai.api_key == "dotenv-openai-key"
