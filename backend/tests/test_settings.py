"""Settings behavior tests."""

from pathlib import Path

from pytest import MonkeyPatch

from timeflow.infrastructure.settings import Settings, get_settings


def test_settings_use_timeflow_environment(monkeypatch: MonkeyPatch) -> None:
    """TIMEFLOW-prefixed variables override development defaults."""
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
