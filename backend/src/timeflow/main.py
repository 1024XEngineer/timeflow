"""FastAPI application composition root."""

from fastapi import FastAPI, WebSocket

from timeflow.business.health import HealthService
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
from timeflow.infrastructure.security.token_verifier import FakeTokenVerifier
from timeflow.infrastructure.settings import get_settings
from timeflow.intelligence.fake_agent import FakeAgent


def create_app(
    *,
    token_verifier: TokenVerifier | None = None,
    audio_sink: AudioSink | None = None,
) -> FastAPI:
    """Build the application and connect the minimal inbound surface."""
    settings = get_settings()
    application = FastAPI(title=settings.app_name, version="0.1.0")
    health_service = HealthService()

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
        # Fail closed like the verifier above: the stand-in agent reports commands as
        # applied that were never carried out.
        if settings.environment != "development":
            raise RuntimeError(
                "No AudioSink was injected and the stand-in agent is development-only; "
                f"TIMEFLOW_ENVIRONMENT is {settings.environment!r}. "
                "It reports commands as applied that were never carried out. "
                "Inject a real sink before exposing /ws."
            )
        audio_sink = AgentAudioSink(FakeAgent(WebSocketResultSink(connections)))

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


app = create_app()
