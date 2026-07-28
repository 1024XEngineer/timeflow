"""Health use case owned by the business layer."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class HealthStatus:
    """Business result for a liveness check."""

    status: Literal["ok"] = "ok"


class HealthService:
    """Return process liveness without depending on an outer adapter."""

    def check(self) -> HealthStatus:
        """Return the current liveness status."""
        return HealthStatus()
