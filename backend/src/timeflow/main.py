"""FastAPI application composition root."""

from fastapi import FastAPI

from timeflow.business.health import HealthService
from timeflow.infrastructure.settings import get_settings


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    application = FastAPI(title=settings.app_name, version="0.1.0")
    health_service = HealthService()

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        """Return the process liveness status."""
        return {"status": health_service.check().status}

    return application


app = create_app()
