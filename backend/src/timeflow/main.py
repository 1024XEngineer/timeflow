"""FastAPI application composition root."""

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.business.schedules import ScheduleService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_repository import SQLAlchemyScheduleRepository
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.handlers.schedules import ScheduleWebSocketHandlers
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
    engine = build_engine(settings.database_url)
    schedule_repository = SQLAlchemyScheduleRepository(build_session_factory(engine))
    schedule_handlers = ScheduleWebSocketHandlers(ScheduleService(schedule_repository))
    router.register("schedule.upsert.command", schedule_handlers.handle_upsert)
    router.register("schedule.list.query", schedule_handlers.handle_list)

    @application.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        """Accept and run a single client's WebSocket session."""
        await run_websocket_session(websocket, router, connections)

    return application


app = create_app()
