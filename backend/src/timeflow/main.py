"""FastAPI application composition root."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from sqlalchemy import Engine

from timeflow.business.auth import AccessTokenService, AuthAccessService
from timeflow.business.health import HealthService
from timeflow.data.account_uow import SqlAlchemyAuthUnitOfWork
from timeflow.data.database import build_engine, build_session_factory
from timeflow.gateway.http import (
    AuthAccess,
    create_auth_router,
    create_authenticated_account_dependency,
    install_auth_http_error_handler,
)
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
from timeflow.gateway.websocket.ports import AudioSink
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.infrastructure.external.realtime.qwen_audio import (
    QwenAudioConfig,
    QwenAudioSessionFactory,
)
from timeflow.infrastructure.security import Argon2PasswordHasher, JwtAccessTokenService
from timeflow.infrastructure.settings import Settings, get_settings
from timeflow.intelligence.fake_agent import FakeAgent
from timeflow.intelligence.realtime.agent import RealtimeAgent

logger = logging.getLogger(__name__)


def create_app(
    *,
    audio_sink: AudioSink | None = None,
    auth_access: AuthAccess | None = None,
    access_token_service: AccessTokenService | None = None,
    engine: Engine | None = None,
) -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    access_tokens = access_token_service or _build_access_token_service(settings)
    owned_engine: Engine | None = None
    if auth_access is None:
        if engine is None:
            engine = build_engine(settings.database_url)
            owned_engine = engine
        session_factory = build_session_factory(engine)
        auth_access = AuthAccessService(
            lambda: SqlAlchemyAuthUnitOfWork(session_factory),
            Argon2PasswordHasher(),
            access_tokens,
        )

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if owned_engine is not None:
                owned_engine.dispose()

    application = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    health_service = HealthService()

    handshake = SessionHandshake(access_tokens)
    connections = ConnectionManager()
    limiter = UnauthenticatedConnectionLimiter(settings.ws_max_unauthenticated_connections)

    if audio_sink is None:
        audio_sink = AgentAudioSink(_build_agent(settings, WebSocketResultSink(connections)))

    voice_streams = VoiceStreamHandlers(
        audio_sink,
        max_audio_duration_ms=settings.ws_max_audio_duration_ms,
        queue_max_chunks=settings.ws_audio_queue_max_chunks,
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)
    router.register("message.ack", handle_message_ack)

    install_auth_http_error_handler(application)
    application.include_router(create_auth_router(auth_access))
    application.state.authenticated_account_dependency = create_authenticated_account_dependency(
        access_tokens
    )

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


def _build_access_token_service(settings: Settings) -> JwtAccessTokenService:
    """构建所有入口共同使用的唯一 v1 JWT 实现。"""
    return JwtAccessTokenService(
        secret=settings.jwt_secret,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        access_ttl_seconds=settings.jwt_access_ttl_seconds,
    )


def _build_agent(settings: Settings, result_sink: WebSocketResultSink) -> Agent:
    """Return the realtime agent when it is configured, otherwise the stand-in.

    Fails closed on the stand-in rather than on the absence of credentials: a configured
    deployment is a real one and should start, while falling back outside development
    would leave a server reporting commands as applied that were never carried out.
    """
    if settings.aliyun_audio_is_configured():
        logger.info("using the realtime model", extra={"model": settings.aliyun_audio_model})
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
