"""FastAPI application composition root."""

import logging

from fastapi import FastAPI, WebSocket
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.calendar.service import ScheduleApplicationService
from timeflow.business.health import HealthService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.gateway.websocket.agent_ports import Agent
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.agent_audio import AgentAudioSink
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.gateway.websocket.handlers.message_ack import handle_message_ack
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.handlers.voice_stream import VoiceStreamHandlers
from timeflow.gateway.websocket.ports import AudioSink, TokenVerifier
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.external.realtime.qwen_audio import (
    QwenAudioConfig,
    QwenAudioSessionFactory,
)
from timeflow.infrastructure.security.token_verifier import FakeTokenVerifier
from timeflow.infrastructure.settings import Settings, get_settings
from timeflow.intelligence.fake_agent import FakeAgent
from timeflow.intelligence.realtime.agent import RealtimeAgent
from timeflow.intelligence.realtime.instructions import build_instructions
from timeflow.intelligence.realtime.schedule_tools import ToolBox

logger = logging.getLogger(__name__)


def create_app(
    *,
    token_verifier: TokenVerifier | None = None,
    audio_sink: AudioSink | None = None,
) -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    application = FastAPI(title=settings.app_name, version="0.1.0")
    health_service = HealthService()

    session_factory = build_session_factory(build_engine(settings.database_url))

    if token_verifier is None:
        # Fail closed: the stand-in verifier accepts any non-empty token, so falling back
        # to it outside development would leave /ws effectively unauthenticated.
        if settings.environment != "development":
            raise RuntimeError(
                "No TokenVerifier was injected and the stand-in one is development-only; "
                f"TIMEFLOW_ENVIRONMENT is {settings.environment!r}. "
                "Inject a real verifier before exposing /ws."
            )
        token_verifier = FakeTokenVerifier()

    handshake = SessionHandshake(token_verifier)
    connections = ConnectionManager()
    limiter = UnauthenticatedConnectionLimiter(settings.ws_max_unauthenticated_connections)

    if audio_sink is None:
        audio_sink = AgentAudioSink(
            _build_agent(settings, WebSocketResultSink(connections), session_factory)
        )

    voice_streams = VoiceStreamHandlers(
        audio_sink,
        max_audio_duration_ms=settings.ws_max_audio_duration_ms,
        queue_max_chunks=settings.ws_audio_queue_max_chunks,
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)
    router.register("message.ack", handle_message_ack)

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        """Return the process liveness status."""
        return {"status": health_service.check().status}

    @application.websocket("/ws")
    async def websocket_session(websocket: WebSocket) -> None:
        """Serve one authenticated voice transport session."""
        await run_websocket_session(
            websocket,
            handshake,
            router,
            connections,
            limiter,
            handshake_timeout_seconds=settings.ws_handshake_timeout_seconds,
            binary_handler=voice_streams.handle_binary,
            disconnect_handler=voice_streams.handle_disconnect,
        )

    return application


def _build_agent(
    settings: Settings,
    result_sink: WebSocketResultSink,
    session_factory: sessionmaker[Session],
) -> Agent:
    """Dispatch on TIMEFLOW_VOICE_AGENT_MODE to the agent backend it selects."""
    if settings.voice_agent_mode == "1":
        return _build_realtime_agent(settings, result_sink, session_factory)
    if settings.voice_agent_mode == "2":
        raise RuntimeError(
            "TIMEFLOW_VOICE_AGENT_MODE=2 selects the LLM+ASR+TTS conversation agent, "
            "which is not wired into the gateway yet (it does not implement the Agent "
            "port). Set TIMEFLOW_VOICE_AGENT_MODE=1 to use the realtime agent."
        )
    # Settings.from_environment already rejects anything but "1" or "2".
    raise AssertionError(f"unreachable voice_agent_mode: {settings.voice_agent_mode!r}")


def _build_realtime_agent(
    settings: Settings,
    result_sink: WebSocketResultSink,
    session_factory: sessionmaker[Session],
) -> Agent:
    """Return the realtime agent when it is configured, otherwise the stand-in.

    Fails closed on the stand-in rather than on the absence of credentials: a configured
    deployment is a real one and should start, while falling back outside development
    would leave a server reporting commands as applied that were never carried out.
    """
    if settings.aliyun_audio_is_configured():
        logger.info("using the realtime model", extra={"model": settings.aliyun_audio_model})

        schedule_service = ScheduleApplicationService(
            lambda: SqlAlchemyScheduleUnitOfWork(session_factory)
        )

        def bind_account(account_id: str) -> ToolBox:
            return ToolBox(account_id, schedule_service)

        return RealtimeAgent(
            QwenAudioSessionFactory(
                QwenAudioConfig(
                    api_key=settings.aliyun_audio_api_key,
                    workspace_id=settings.aliyun_audio_workspace_id,
                    model=settings.aliyun_audio_model,
                    region=settings.aliyun_audio_region,
                    voice=settings.aliyun_audio_voice,
                )
            ),
            result_sink,
            tools_factory=bind_account,
            instructions=build_instructions,
        )

    if settings.environment != "development":
        raise RuntimeError(
            "The realtime model is not configured and the stand-in agent is "
            f"development-only; TIMEFLOW_ENVIRONMENT is {settings.environment!r}. "
            "Set TIMEFLOW_ALIYUN_AUDIO_API_KEY and TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID, "
            "or inject an AudioSink, before exposing /ws."
        )
    logger.info(
        "realtime model not configured, using the stand-in agent",
        extra={"needs": "TIMEFLOW_ALIYUN_AUDIO_API_KEY and TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID"},
    )
    return FakeAgent(result_sink)


app = create_app()
