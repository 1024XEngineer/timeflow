"""FastAPI application composition root."""

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.router import MessageRouter


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    application = FastAPI(title=settings.app_name, version="0.1.0")
    health_service = HealthService()

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        """Return the process liveness status."""
        return {"status": health_service.check().status}

    connections = ConnectionManager()
    router = MessageRouter()

    @application.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        """Accept and run a single client's WebSocket session."""
        await run_websocket_session(websocket, router, connections)

    return application


app = create_app()
