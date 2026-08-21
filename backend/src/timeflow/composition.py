"""Composition-root factory for the injectable composed voice agent."""

from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.calendar import ScheduleApplicationService
from timeflow.data.database import build_engine, build_session_factory
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.infrastructure.external.asr.qwen_realtime import QwenRealtimeAsr
from timeflow.infrastructure.external.llm.openai_compatible import OpenAICompatibleLlm
from timeflow.infrastructure.external.tts.qwen_audio_tts import QwenAudioTts
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.composed.agent import ComposedVoiceAgent
from timeflow.intelligence.conversation.agent import Agent
from timeflow.intelligence.conversation.schedule_tools import ScheduleResultObserver
from timeflow.intelligence.conversation.tools import build_agent_tool_registry
from timeflow.intelligence.location import ClientLocation, LocationSearchService
from timeflow.intelligence.ports import ResultSink


def build_composed_voice_agent(
    settings: Settings,
    result_sink: ResultSink,
    *,
    session_factory: sessionmaker[Session] | None = None,
    location_service: LocationSearchService | None = None,
) -> ComposedVoiceAgent:
    """Build complete composed dependencies for the mode-2 gateway adapter."""
    _validate_settings(settings)
    if session_factory is None:
        engine = build_engine(settings.database_url)
        session_factory = build_session_factory(engine)
    schedule_service = ScheduleApplicationService(
        lambda: SqlAlchemyScheduleUnitOfWork(session_factory)
    )
    llm = OpenAICompatibleLlm(settings)

    def agent_factory(
        account_id: str,
        observer: ScheduleResultObserver,
        client_location: ClientLocation | None,
    ) -> Agent:
        return Agent(
            llm,
            build_agent_tool_registry(
                schedule_service,
                account_id,
                observer,
                location_service=location_service,
                client_location=client_location,
            ),
            max_tool_rounds=settings.agent_max_tool_rounds,
        )

    return ComposedVoiceAgent(
        QwenRealtimeAsr(settings),
        agent_factory,
        QwenAudioTts(settings),
        result_sink,
        location_service=location_service,
    )


def _validate_settings(settings: Settings) -> None:
    missing: list[str] = []
    for name, value in (
        ("TIMEFLOW_DATABASE_URL", settings.database_url),
        ("TIMEFLOW_ALIYUN_ASR_WS_URL", settings.aliyun_asr_ws_url),
        ("TIMEFLOW_ALIYUN_ASR_API_KEY", settings.aliyun_asr_api_key),
        ("TIMEFLOW_OPENAI_BASE_URL", settings.openai_base_url),
        ("TIMEFLOW_OPENAI_API_KEY", settings.openai_api_key),
        ("TIMEFLOW_ALIYUN_TTS_WS_URL", settings.aliyun_tts_ws_url),
        ("TIMEFLOW_ALIYUN_TTS_API_KEY", settings.aliyun_tts_api_key),
    ):
        if not value:
            missing.append(name)
    if missing:
        raise RuntimeError(f"Composed voice agent is not configured: {', '.join(missing)}")


__all__ = ["build_composed_voice_agent"]
