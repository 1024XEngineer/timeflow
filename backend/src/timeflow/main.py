"""FastAPI application composition root."""

from fastapi import FastAPI

from timeflow.api.router import api_router
from timeflow.infrastructure.settings import get_settings


def create_app() -> FastAPI:
    """Build the HTTP application and connect inbound adapters."""
    settings = get_settings()
    application = FastAPI(title=settings.app_name, version="0.1.0")
    application.include_router(api_router)
    return application


app = create_app()
