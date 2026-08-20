"""Composition-root validation for the injectable composed voice agent."""

from dataclasses import replace

import pytest

from timeflow.composition import build_composed_voice_agent
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.composed import ComposedVoiceAgent


class NullResultSink:
    async def deliver_transcript(self, transcript: object, stream: object) -> None: ...

    async def deliver_reply_text(self, reply: object, stream: object) -> None: ...

    async def deliver_result(self, result: object, stream: object) -> None: ...

    async def deliver_question(self, question: object, stream: object) -> None: ...

    async def deliver_audio(self, reply: object, chunks: object, stream: object) -> None: ...

    async def deliver_canceled(self, canceled: object, stream: object) -> None: ...

    async def deliver_session_end(self, stream: object) -> None: ...


def settings() -> Settings:
    return Settings(
        app_name="TimeFlow",
        environment="development",
        database_url="sqlite+pysqlite:///:memory:",
        ws_handshake_timeout_seconds=5,
        ws_max_unauthenticated_connections=10,
        ws_audio_queue_max_chunks=8,
        ws_max_audio_duration_ms=120000,
        aliyun_asr_ws_url="wss://asr.example.test",
        aliyun_asr_api_key="asr-test-key",
        openai_base_url="https://llm.example.test/v1",
        openai_api_key="llm-test-key",
        aliyun_tts_ws_url="wss://tts.example.test",
        aliyun_tts_api_key="tts-test-key",
    )


def test_factory_builds_injectable_agent_without_changing_app_default() -> None:
    agent = build_composed_voice_agent(settings(), NullResultSink())

    assert isinstance(agent, ComposedVoiceAgent)


@pytest.mark.parametrize(
    ("field", "setting_name"),
    [
        ("database_url", "TIMEFLOW_DATABASE_URL"),
        ("aliyun_asr_ws_url", "TIMEFLOW_ALIYUN_ASR_WS_URL"),
        ("aliyun_asr_api_key", "TIMEFLOW_ALIYUN_ASR_API_KEY"),
        ("openai_base_url", "TIMEFLOW_OPENAI_BASE_URL"),
        ("openai_api_key", "TIMEFLOW_OPENAI_API_KEY"),
        ("aliyun_tts_ws_url", "TIMEFLOW_ALIYUN_TTS_WS_URL"),
        ("aliyun_tts_api_key", "TIMEFLOW_ALIYUN_TTS_API_KEY"),
    ],
)
def test_factory_fails_fast_for_missing_composed_configuration(
    field: str,
    setting_name: str,
) -> None:
    with pytest.raises(RuntimeError, match=setting_name):
        build_composed_voice_agent(replace(settings(), **{field: ""}), NullResultSink())
