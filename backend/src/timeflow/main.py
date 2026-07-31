"""FastAPI application composition root."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.business.reminders import ReminderAudioGenerationService
from timeflow.business.reminders.geofence_trigger import GeofenceTransition, GeofenceTriggerService
from timeflow.business.reminders.reminder_dispatch import TriggeredSchedule
from timeflow.business.reminders.time_window_trigger import TimeWindowTriggerService
from timeflow.business.schedules import ScheduleService
from timeflow.business.voice import VoiceScheduleParsingService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.reminder_audio_storage import FileReminderAudioStorage
from timeflow.data.schedule_dispatch import SqlAlchemyScheduleDispatchAdapter
from timeflow.data.schedule_repository import SQLAlchemyScheduleRepository
from timeflow.gateway.aliyun_asr import AliyunASRClient
from timeflow.gateway.aliyun_tts import AliyunTTSClient
from timeflow.gateway.openai_llm import OpenAILLMClient
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.handlers.location import LocationWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.reminders import ReminderWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.schedules import ScheduleWebSocketHandlers
from timeflow.infrastructure.websocket.handlers.voice import VoiceWebSocketHandlers
from timeflow.infrastructure.websocket.reminder_audio import (
    ReminderAudioGenerationTracker,
    ReminderAudioSender,
)
from timeflow.infrastructure.websocket.router import MessageRouter
from timeflow.infrastructure.workers.reminder_dispatcher import ReminderDispatcher
from timeflow.intelligence.schedule_parser import ScheduleDraftParser

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    llm_client = OpenAILLMClient(settings.openai)
    tts_client = AliyunTTSClient(settings.aliyun_tts)
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
                    marked = dispatch_adapter.mark_time_triggered(schedule.id, now)
                    session.commit()
                except Exception:
                    session.rollback()
                    logger.exception("dispatch tick failed for schedule %s", schedule.id)
                    continue
                if marked:
                    results.append(
                        TriggeredSchedule(
                            schedule_id=schedule.id,
                            user_id=schedule.user_id,
                            reason="time_window_reached",
                        )
                    )
        return results

    def run_geofence_report(
        user_id: str, latitude: float, longitude: float, now: datetime
    ) -> list[TriggeredSchedule]:
        """Judge this location report's geofence transitions and stamp hits as triggered."""
        results: list[TriggeredSchedule] = []
        with session_factory() as session:
            dispatch_adapter = SqlAlchemyScheduleDispatchAdapter(session)
            transitions = GeofenceTriggerService(dispatch_adapter).find_geofence_transitions(
                user_id, latitude, longitude
            )
            for schedule, transition in transitions:
                try:
                    if transition is GeofenceTransition.ARMED:
                        dispatch_adapter.set_geofence_armed(schedule.id, True)
                        session.commit()
                    elif transition is GeofenceTransition.TRIGGERED:
                        marked = dispatch_adapter.mark_geo_triggered(schedule.id, now)
                        session.commit()
                        if marked:
                            results.append(
                                TriggeredSchedule(
                                    schedule_id=schedule.id,
                                    user_id=schedule.user_id,
                                    reason="geofence_entered",
                                )
                            )
                except Exception:
                    session.rollback()
                    logger.exception("geofence report failed for schedule %s", schedule.id)
        return results

    def mark_schedule_done(schedule_id: str, updated_at: datetime) -> bool:
        """Close a schedule once its reminder was acknowledged (架构设计.md §8.4)。"""
        with session_factory() as session:
            try:
                marked = SqlAlchemyScheduleDispatchAdapter(session).mark_done(
                    schedule_id, updated_at
                )
                session.commit()
            except Exception:
                session.rollback()
                logger.exception("failed to mark schedule %s as done", schedule_id)
                return False
        return marked

    health_service = HealthService()
    connections = ConnectionManager()
    router = MessageRouter()
    schedule_repository = SQLAlchemyScheduleRepository(session_factory)
    audio_storage = FileReminderAudioStorage(settings.reminder_audio_dir)
    reminder_audio_service = ReminderAudioGenerationService(
        schedule_repository.get,
        tts_client,
        audio_storage,
        user_id="default_user",
    )
    # tracker 必须先于 audio_sender 和 schedule_handlers 创建:前者下发提醒时要靠它
    # 判断音频是否还在生成中(有界等待),后者负责把生成任务登记进去。
    audio_generation_tracker = ReminderAudioGenerationTracker(reminder_audio_service)
    audio_sender = ReminderAudioSender(
        connections,
        audio_storage,
        generation_tracker=audio_generation_tracker,
    )
    dispatcher = ReminderDispatcher(
        connections,
        run_dispatch_tick,
        reminder_sender=audio_sender,
        mark_done=mark_schedule_done,
    )
    reminder_handlers = ReminderWebSocketHandlers(dispatcher)
    location_handlers = LocationWebSocketHandlers(run_geofence_report, dispatcher, connections)
    schedule_handlers = ScheduleWebSocketHandlers(
        ScheduleService(schedule_repository),
        reminder_audio_service,
        generation_tracker=audio_generation_tracker,
    )
    voice_service = VoiceScheduleParsingService(
        AliyunASRClient(settings.aliyun_asr),
        ScheduleDraftParser(llm_client),
    )
    voice_handlers = VoiceWebSocketHandlers(voice_service, connections)

    router.register("reminder.control.ack", reminder_handlers.handle_control_ack)
    router.register("reminder.audio.ack", reminder_handlers.handle_audio_ack)
    router.register("location.report", location_handlers.handle_report)
    router.register("schedule.upsert.command", schedule_handlers.handle_upsert)
    router.register("schedule.list.query", schedule_handlers.handle_list)
    router.register("schedule.deleted", schedule_handlers.handle_deleted)
    router.register("voice.stream.start", voice_handlers.handle_start)
    router.register("voice.stream.end", voice_handlers.handle_end)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        del app
        task = asyncio.create_task(dispatcher.run_forever())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await schedule_handlers.aclose()
            await llm_client.aclose()
            await tts_client.aclose()

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    application.state.reminder_audio_sender = audio_sender

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
