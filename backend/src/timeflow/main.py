"""FastAPI application composition root."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.business.schedules import ScheduleService
from timeflow.business.voice import VoiceScheduleParsingService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_repository import SQLAlchemyScheduleRepository
from timeflow.gateway.aliyun_asr import AliyunASRClient
from timeflow.gateway.openai_llm import OpenAILLMClient
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.handlers.schedules import ScheduleWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.voice import VoiceWebSocketHandlers
from timeflow.infrastructure.websocket.router import MessageRouter
from timeflow.intelligence.schedule_parser import ScheduleDraftParser


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    llm_client = OpenAILLMClient(settings.openai)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await llm_client.aclose()

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
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
    voice_service = VoiceScheduleParsingService(
        AliyunASRClient(settings.aliyun_asr),
        ScheduleDraftParser(llm_client),
    )
    voice_handlers = VoiceWebSocketHandlers(voice_service, connections)
    router.register("schedule.upsert.command", schedule_handlers.handle_upsert)
    router.register("schedule.list.query", schedule_handlers.handle_list)
    router.register("schedule.deleted", schedule_handlers.handle_deleted)
    router.register("voice.stream.start", voice_handlers.handle_start)
    router.register("voice.stream.end", voice_handlers.handle_end)

    @application.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        """Accept and run a single client's WebSocket session."""
        await run_websocket_session(
            websocket,
            router,
            connections,
            binary_handler=voice_handlers.handle_binary,
            reply_sent_handler=voice_handlers.handle_reply_sent,
            disconnect_handler=voice_handlers.handle_disconnect,
        )

    return application


app = create_app()
