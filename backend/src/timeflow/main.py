"""FastAPI application composition root."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.business.reminders.time_window_trigger import TimeWindowTriggerService
from timeflow.business.schedules import ScheduleService
from timeflow.business.voice import VoiceScheduleParsingService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_dispatch import SqlAlchemyScheduleDispatchAdapter
from timeflow.data.schedule_repository import SQLAlchemyScheduleRepository
from timeflow.gateway.aliyun_asr import AliyunASRClient
from timeflow.gateway.openai_llm import OpenAILLMClient
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.handlers.reminders import ReminderWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.schedules import ScheduleWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.voice import VoiceWebSocketHandlers
from timeflow.infrastructure.websocket.router import MessageRouter
from timeflow.infrastructure.workers.reminder_dispatcher import ReminderDispatcher
from timeflow.intelligence.schedule_parser import ScheduleDraftParser

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    llm_client = OpenAILLMClient(settings.openai)
    engine = build_engine(settings.database_url)
    session_factory = build_session_factory(engine)

    def run_dispatch_tick(now: datetime) -> list[TriggeredSchedule]:
        """Find schedules entering their time window and stamp them as triggered."""
        results: list[TriggeredSchedule] = []
        with session_factory() as session:
            dispatch_adapter = SqlAlchemyScheduleDispatchAdapter(session)
            due_schedules = TimeWindowTriggerService(
                dispatch_adapter
            ).find_schedules_entering_window(now)
            for schedule in due_schedules:
                try:
                    if dispatch_adapter.mark_time_triggered(schedule.id, now):
                        results.append(
                            TriggeredSchedule(
                                schedule_id=schedule.id,
                                user_id=schedule.user_id,
                                reason="time_window_reached",
                            )
                        )
                    session.commit()
                except Exception:
                    session.rollback()
                    logger.exception("dispatch tick failed for schedule %s", schedule.id)
        return results

    health_service = HealthService()
    connections = ConnectionManager()
    router = MessageRouter()
    dispatcher = ReminderDispatcher(connections, run_dispatch_tick)
    reminder_handlers = ReminderWebSocketHandlers(dispatcher)

    router.register("reminder.control.ack", reminder_handlers.handle_control_ack)

    schedule_repository = SQLAlchemyScheduleRepository(session_factory)
    schedule_handlers = ScheduleWebSocketHandlers(ScheduleService(schedule_repository))
    voice_service = VoiceScheduleParsingService(
        AliyunASRClient(settings.aliyun_asr),
        ScheduleDraftParser(llm_client),
    )
    voice_handlers = VoiceWebSocketHandlers(voice_service, connections)
    router.register("schedule.upsert.command", schedule_handlers.handle_upsert)
    router.register("schedule.list.query", schedule_handlers.handle_list)
    router.register("voice.stream.start", voice_handlers.handle_start)
    router.register("voice.stream.end", voice_handlers.handle_end)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(dispatcher.run_forever())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await llm_client.aclose()

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        """Return the process liveness status."""
        return {"status": health_service.check().status}

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
