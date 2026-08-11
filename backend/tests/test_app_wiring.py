"""What the composition root refuses to build."""

import os
from unittest import mock

from timeflow.infrastructure.settings import get_settings
from timeflow.main import create_app


class _RealVerifier:
    """A verifier that is not the development stand-in, so the first guard is satisfied."""

    async def verify(self, access_token: str) -> str | None:
        """Accept nothing; the tests using this never open a session."""
        return None


def _build_with_environment(environment: str, **injected: object) -> object:
    """Build the app with TIMEFLOW_ENVIRONMENT set, clearing the settings cache around it."""
    get_settings.cache_clear()
    try:
        with mock.patch.dict(os.environ, {"TIMEFLOW_ENVIRONMENT": environment}, clear=False):
            return create_app(**injected)  # type: ignore[arg-type]
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


def test_building_outside_development_without_a_sink_fails_closed() -> None:
    """A real verifier is not enough: a missing sink must be refused too."""
    try:
        _build_with_environment("production", token_verifier=_RealVerifier())
    except RuntimeError as error:
        assert "AudioSink" in str(error)
        return
    raise AssertionError("expected create_app to refuse the stand-in agent")


def test_building_outside_development_works_once_both_are_injected() -> None:
    """Neither guard fires when the deployment supplies what it is supposed to."""

    class _Sink:
        """A sink that is never fed, because no session is opened here."""

        async def consume(self, chunks: object, stream: object) -> None:
            """Do nothing with the audio."""

    built = _build_with_environment(
        "production", token_verifier=_RealVerifier(), audio_sink=_Sink()
    )

    assert built is not None
