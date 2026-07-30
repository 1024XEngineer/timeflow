"""FastAPI application composition root."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Protocol

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
from timeflow.business.schedules.reminder_dispatch import TriggeredSchedule, decide_next_step
from timeflow.business.schedules.time_window_trigger import TimeWindowTriggerService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_dispatch_command import SqlAlchemyScheduleDispatchCommandAdapter
from timeflow.data.schedule_query import SqlAlchemyScheduleQueryAdapter
from timeflow.infrastructure.settings import get_settings
from timeflow.infrastructure.websocket.connection_manager import ConnectionManager
from timeflow.infrastructure.websocket.endpoint import run_websocket_session
from timeflow.infrastructure.websocket.messages.reminder import (
    SystemRefsCheckResult,
    SystemScheduleDeleteAck,
)
from timeflow.infrastructure.websocket.router import MessageHandler, MessageRouter
from timeflow.infrastructure.workers.time_window_dispatcher import TimeWindowDispatcher

logger = logging.getLogger(__name__)


class _RefsCheckReplyReceiver(Protocol):
    async def handle_refs_check_reply(self, schedule_id: str, calendar_exists: bool) -> None: ...


def build_refs_check_result_handler(dispatcher: _RefsCheckReplyReceiver) -> MessageHandler:
    """Build the `system.refs.check.result` handler; it only parses and forwards."""

    async def handle_refs_check_result(raw_message: dict[str, Any], device_id: str) -> None:
        result = SystemRefsCheckResult.model_validate(raw_message)
        calendar_exists = (
            result.system_schedule_exists
            if (result.ok and result.system_schedule_exists is not None)
            else True
        )
        await dispatcher.handle_refs_check_reply(result.schedule_id, calendar_exists)
        return None

    return handle_refs_check_result


def build_schedule_delete_ack_handler(
    clear_system_schedule_ref: Callable[[str], None],
) -> MessageHandler:
    """Build the `system.schedule.delete.ack` handler; it only parses and forwards."""

    async def handle_schedule_delete_ack(raw_message: dict[str, Any], device_id: str) -> None:
        ack = SystemScheduleDeleteAck.model_validate(raw_message)
        if ack.ok:
            await asyncio.to_thread(clear_system_schedule_ref, ack.schedule_id)
        return None

    return handle_schedule_delete_ack


def create_app() -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    engine = build_engine(settings.database_url)
    session_factory = build_session_factory(engine)

    def run_dispatch_tick(now: datetime) -> list[TriggeredSchedule]:
        """Find newly-triggered schedules, stamp them, and decide their next step."""
        results: list[TriggeredSchedule] = []
        with session_factory() as session:
            query_port = SqlAlchemyScheduleQueryAdapter(session)
            command_port = SqlAlchemyScheduleDispatchCommandAdapter(session)
            snapshots = TimeWindowTriggerService(query_port).find_snapshots_entering_window(now)
            for snapshot in snapshots:
                try:
                    command_port.mark_triggered(snapshot.schedule_id, now)
                    results.append(
                        TriggeredSchedule(
                            schedule_id=snapshot.schedule_id,
                            user_id=snapshot.user_id,
                            system_schedule_ref_id=snapshot.system_schedule_ref_id,
                            next_step=decide_next_step(snapshot),
                        )
                    )
                    session.commit()
                except Exception:
                    session.rollback()
                    logger.exception("dispatch tick failed for schedule %s", snapshot.schedule_id)
        return results

    def cancel_schedule(schedule_id: str) -> None:
        """Mark a schedule as deleted after its system calendar entry was removed."""
        with session_factory() as session:
            SqlAlchemyScheduleDispatchCommandAdapter(session).cancel(schedule_id)
            session.commit()

    def clear_system_schedule_ref(schedule_id: str) -> None:
        """Clear the stored system calendar reference after a successful cleanup ack."""
        with session_factory() as session:
            SqlAlchemyScheduleDispatchCommandAdapter(session).clear_system_schedule_ref(
                schedule_id
            )
            session.commit()

    health_service = HealthService()
    connections = ConnectionManager()
    router = MessageRouter()
    dispatcher = TimeWindowDispatcher(connections, run_dispatch_tick, cancel_schedule)

    router.register(
        "system.refs.check.result", build_refs_check_result_handler(dispatcher)
    )
    router.register(
        "system.schedule.delete.ack", build_schedule_delete_ack_handler(clear_system_schedule_ref)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(dispatcher.run_forever())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        """Return the process liveness status."""
        return {"status": health_service.check().status}

    @application.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        """Accept and run a single client's WebSocket session."""
        await run_websocket_session(websocket, router, connections)

    return application


app = create_app()
