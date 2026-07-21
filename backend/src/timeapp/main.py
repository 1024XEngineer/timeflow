"""FastAPI application entry point."""

from fastapi import FastAPI

from timeapp import __version__
from timeapp.api.router import api_router
from timeapp.core.config import get_settings


def create_app() -> FastAPI:
    """创建并配置 FastAPI 应用。"""

    settings = get_settings()
    application = FastAPI(
        title=settings.app_name,
        version=__version__,
        debug=settings.debug,
    )
    application.include_router(api_router, prefix=settings.api_v1_prefix)
    return application


app = create_app()
