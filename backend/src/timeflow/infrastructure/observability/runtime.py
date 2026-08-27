"""Process-wide observability bootstrap used by the composition root."""

from __future__ import annotations

from timeflow.infrastructure.observability.tracing import configure_tracing
from timeflow.infrastructure.settings import Settings


def configure_observability(settings: Settings, *, force: bool = False) -> None:
    """Install tracing export. Prometheus instruments register at import time."""
    configure_tracing(settings, force=force)


__all__ = ["configure_observability"]
