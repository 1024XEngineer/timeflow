"""FastAPI application composition root."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.auth import AccessTokenService, AuthAccessService
from timeflow.business.calendar import (
    ReminderDispositionConfirmer,
    ReminderDispositionService,
    ScheduleSnapshotQueryService,
    ScheduleSnapshotReader,
)
from timeflow.business.calendar.service import ScheduleApplicationService
from timeflow.business.health import HealthService
from timeflow.composition import build_composed_voice_agent
from timeflow.data.account_uow import SqlAlchemyAuthUnitOfWork
from timeflow.data.database import build_engine, build_session_factory, ping_database
from timeflow.data.repositories.account import AccountRepository
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.gateway.http import (
    AuthAccess,
    AuthRateLimiter,
    create_auth_router,
    create_authenticated_account_dependency,
    create_reminder_state_router,
    create_schedule_snapshot_router,
    install_auth_http_error_handler,
)
from timeflow.gateway.observability.http import install_http_observability, record_health
from timeflow.gateway.websocket.agent_ports import Agent
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.agent_audio import AgentAudioSink
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.gateway.websocket.handlers.composed_audio import ComposedAgentAudioSink
from timeflow.gateway.websocket.handlers.message_ack import handle_message_ack
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.handlers.voice_stream import VoiceStreamHandlers
from timeflow.gateway.websocket.ports import AudioSink
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.external.llm import OpenAICompatibleJsonLlm
from timeflow.infrastructure.external.location.tencent_maps import TencentMapsLocationPort
from timeflow.infrastructure.external.realtime.qwen_audio import (
    QwenAudioConfig,
    QwenAudioSessionFactory,
)
from timeflow.infrastructure.observability.runtime import configure_observability
from timeflow.infrastructure.observability.sessions import VOICE_SESSION_OCCUPANCY
from timeflow.infrastructure.security import Argon2PasswordHasher, JwtAccessTokenService
from timeflow.infrastructure.settings import Settings, get_settings
from timeflow.intelligence.fake_agent import FakeAgent
from timeflow.intelligence.location import ClientLocation, LocationSearchService
from timeflow.intelligence.realtime.agent import RealtimeAgent
from timeflow.intelligence.realtime.instructions import build_instructions
from timeflow.intelligence.realtime.schedule_tools import ToolBox
from timeflow.intelligence.schedule_category import LlmScheduleCategoryClassifier
from timeflow.observability import VOICE_TELEMETRY

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def create_app(
    *,
    audio_sink: AudioSink | None = None,
    auth_access: AuthAccess | None = None,
    access_token_service: AccessTokenService | None = None,
    engine: Engine | None = None,
    auth_rate_limiter: AuthRateLimiter | None = None,
    schedule_snapshot_reader: ScheduleSnapshotReader | None = None,
    reminder_disposition_confirmer: ReminderDispositionConfirmer | None = None,
) -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    configure_observability(settings)
    access_tokens = access_token_service or _build_access_token_service(settings)
    owned_engine: Engine | None = None
    session_factory: sessionmaker[Session] | None = None
    owned_http_client: httpx.AsyncClient | None = None

    # 认证仓储和实时日程工具共用同一个数据库会话工厂，避免两套连接池分裂。
    if engine is None and (
        auth_access is None
        or audio_sink is None
        or schedule_snapshot_reader is None
        or reminder_disposition_confirmer is None
    ):
        engine = build_engine(settings.database_url)
        owned_engine = engine
    if engine is not None:
        session_factory = build_session_factory(engine)
        accounts = session_factory

        def username_for(account_id: str) -> str | None:
            with accounts() as session:
                record = AccountRepository(session).get_by_id(account_id)
            return None if record is None else record.username

        VOICE_TELEMETRY.bind_username_lookup(username_for)

    if auth_access is None:
        assert session_factory is not None
        auth_access = AuthAccessService(
            lambda: SqlAlchemyAuthUnitOfWork(session_factory),
            Argon2PasswordHasher(),
            access_tokens,
        )

    if schedule_snapshot_reader is None:
        assert session_factory is not None
        schedule_snapshot_reader = ScheduleSnapshotQueryService(
            lambda: SqlAlchemyScheduleUnitOfWork(session_factory)
        )

    if reminder_disposition_confirmer is None:
        assert session_factory is not None
        reminder_disposition_confirmer = ReminderDispositionService(
            lambda: SqlAlchemyScheduleUnitOfWork(session_factory)
        )

    # Both agent modes share the same owned Tencent HTTP client and location service; the
    # client is closed by lifespan's finally once the application shuts down.
    location_service: LocationSearchService | None = None
    if audio_sink is None and settings.tencent_maps_is_configured():
        owned_http_client = httpx.AsyncClient(timeout=settings.tencent_map_timeout_seconds)
        location_service = LocationSearchService(
            TencentMapsLocationPort(
                owned_http_client, settings.tencent_map_api_key, settings.tencent_map_base_url
            )
        )

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if owned_engine is not None:
                owned_engine.dispose()
            if owned_http_client is not None:
                await owned_http_client.aclose()

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    if settings.cors_allowed_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_allowed_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["Retry-After", "X-Auth-Event-Id"],
        )
    install_http_observability(application)
    health_service = HealthService()

    handshake = SessionHandshake(access_tokens)
    connections = ConnectionManager()
    limiter = UnauthenticatedConnectionLimiter(settings.ws_max_unauthenticated_connections)

    if audio_sink is None:
        assert session_factory is not None
        result_sink = WebSocketResultSink(connections, sessions=VOICE_SESSION_OCCUPANCY)
        if settings.voice_agent_mode == "1":
            audio_sink = AgentAudioSink(
                _build_realtime_agent(settings, result_sink, session_factory, location_service)
            )
        else:
            audio_sink = ComposedAgentAudioSink(
                build_composed_voice_agent(
                    settings,
                    result_sink,
                    session_factory=session_factory,
                    location_service=location_service,
                    category_event_publisher=result_sink.publish_schedule_category_updated,
                )
            )

    voice_streams = VoiceStreamHandlers(
        audio_sink,
        max_audio_duration_ms=settings.ws_max_audio_duration_ms,
        max_continuous_audio_duration_ms=settings.ws_max_continuous_audio_duration_ms,
        queue_max_chunks=settings.ws_audio_queue_max_chunks,
        sessions=VOICE_SESSION_OCCUPANCY,
        agent_mode=_voice_agent_mode_label(settings),
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)
    router.register("message.ack", handle_message_ack)

    install_auth_http_error_handler(application)
    authenticated_account = create_authenticated_account_dependency(access_tokens)
    application.include_router(create_auth_router(auth_access, rate_limiter=auth_rate_limiter))
    application.include_router(
        create_schedule_snapshot_router(schedule_snapshot_reader, authenticated_account)
    )
    application.include_router(
        create_reminder_state_router(
            reminder_disposition_confirmer,
            authenticated_account,
        )
    )
    application.state.authenticated_account_dependency = authenticated_account

    @application.get("/api/v1/health")
    def health() -> dict[str, object]:
        """Return process liveness plus bounded dependency readiness, never payloads."""
        checks = {
            "process": "ok",
            "database": _database_readiness(engine),
            "asr": _configured_state(
                bool(settings.aliyun_asr_ws_url and settings.aliyun_asr_api_key)
            ),
            "llm": _configured_state(settings.openai_is_configured()),
            "tts": _configured_state(
                bool(settings.aliyun_tts_ws_url and settings.aliyun_tts_api_key)
            ),
            "realtime": _configured_state(settings.aliyun_audio_is_configured()),
            "maps": _configured_state(settings.tencent_maps_is_configured()),
        }
        record_health(checks)
        return {"status": health_service.check().status, "checks": checks}

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
            agent_mode=_voice_agent_mode_label(settings),
            sessions=VOICE_SESSION_OCCUPANCY,
        )

    return application


def _build_access_token_service(settings: Settings) -> JwtAccessTokenService:
    """构建所有入口共同使用的唯一 v1 JWT 实现。"""
    return JwtAccessTokenService(
        secret=settings.jwt_secret,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        access_ttl_seconds=settings.jwt_access_ttl_seconds,
    )


def _build_realtime_agent(
    settings: Settings,
    result_sink: WebSocketResultSink,
    session_factory: sessionmaker[Session],
    location_service: LocationSearchService | None,
) -> Agent:
    """Return the realtime agent when it is configured, otherwise the stand-in.

    Fails closed on the stand-in rather than on the absence of credentials: a configured
    deployment is a real one and should start, while falling back outside development
    would leave a server reporting commands as applied that were never carried out.
    """
    if settings.aliyun_audio_is_configured():
        logger.info("using the realtime model", extra={"model": settings.aliyun_audio_model})

        category_classifier = None
        if settings.openai_is_configured():
            category_classifier = LlmScheduleCategoryClassifier(
                OpenAICompatibleJsonLlm(
                    settings,
                    timeout_seconds=settings.schedule_category_timeout_seconds,
                )
            )
        else:
            logger.warning(
                "schedule category classification is not configured; leaving category null",
                extra={
                    "needs": (
                        "TIMEFLOW_OPENAI_BASE_URL, TIMEFLOW_OPENAI_API_KEY, "
                        "and TIMEFLOW_OPENAI_MODEL"
                    )
                },
            )

        schedule_service = ScheduleApplicationService(
            lambda: SqlAlchemyScheduleUnitOfWork(session_factory),
            category_classifier=category_classifier,
            category_event_publisher=result_sink.publish_schedule_category_updated,
        )

        async def bind_account(
            account_id: str, timezone: str, client_location: ClientLocation | None
        ) -> ToolBox:
            # Preparing a LocationSearchContext from client_location -- and retrying it
            # if the provider is briefly unreachable -- is ToolBox's job, not this
            # factory's; see its docstring.
            return ToolBox(
                account_id,
                schedule_service,
                timezone,
                location_service=location_service,
                client_location=client_location,
                telemetry=VOICE_TELEMETRY,
            )

        return RealtimeAgent(
            QwenAudioSessionFactory(
                QwenAudioConfig(
                    api_key=settings.aliyun_audio_api_key,
                    workspace_id=settings.aliyun_audio_workspace_id,
                    model=settings.aliyun_audio_model,
                    region=settings.aliyun_audio_region,
                    voice=settings.aliyun_audio_voice,
                    turn_detection=settings.aliyun_audio_turn_detection,
                    vad_threshold=settings.aliyun_audio_vad_threshold,
                    vad_silence_duration_ms=settings.aliyun_audio_vad_silence_duration_ms,
                )
            ),
            result_sink,
            tools_factory=bind_account,
            instructions=build_instructions,
            telemetry=VOICE_TELEMETRY,
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


def _voice_agent_mode_label(settings: Settings) -> str:
    return "composed" if settings.voice_agent_mode == "2" else "realtime"


def _configured_state(configured: bool) -> str:
    return "configured" if configured else "unconfigured"


def _database_readiness(engine: Engine | None) -> str:
    if engine is None:
        return "skipped"
    return "ok" if ping_database(engine) else "error"


app = create_app()
