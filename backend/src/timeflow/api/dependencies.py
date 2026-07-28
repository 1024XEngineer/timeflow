"""FastAPI dependency providers."""

from functools import lru_cache

from timeflow.business.health import HealthService


@lru_cache
def get_health_service() -> HealthService:
    """Return the process-wide stateless health service."""
    return HealthService()
