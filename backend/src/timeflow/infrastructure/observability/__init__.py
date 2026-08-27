"""Runtime observability adapters: Prometheus instruments and Tempo tracing."""

from timeflow.infrastructure.observability.runtime import configure_observability

__all__ = ["configure_observability"]
