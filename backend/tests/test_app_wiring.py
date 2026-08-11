"""What the composition root refuses to build."""

import os
from unittest import mock

from timeflow.infrastructure.settings import get_settings
from timeflow.main import create_app


def _build_with_environment(environment: str) -> object:
    """Build the app with TIMEFLOW_ENVIRONMENT set, clearing the settings cache around it."""
    get_settings.cache_clear()
    try:
        with mock.patch.dict(os.environ, {"TIMEFLOW_ENVIRONMENT": environment}, clear=False):
            return create_app()
    finally:
        get_settings.cache_clear()


def test_building_outside_development_without_a_verifier_fails_closed() -> None:
    """create_app refuses to fall back to the stand-in verifier in a deployed environment.

    The stand-in accepts every non-empty token, so falling back to it would leave /ws
    effectively unauthenticated: any client could open an authenticated session and
    submit audio. Failing at construction surfaces that before the route is exposed.
    """
    try:
        _build_with_environment("production")
    except RuntimeError as error:
        assert "development-only" in str(error)
        return
    raise AssertionError("expected create_app to refuse the stand-in verifier")


def test_building_in_development_still_works_without_a_verifier() -> None:
    """Development keeps working without wiring a verifier that does not exist yet."""
    assert _build_with_environment("development") is not None
