"""Lifecycle and context translation for the composed Gateway adapter."""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from timeflow.gateway.websocket.handlers.composed_audio import ComposedAgentAudioSink
from timeflow.gateway.websocket.ports import AudioConfig, SessionContext, StreamContext


@dataclass
class RecordingAgent:
    """Record audio and lifecycle calls made by the composed adapter."""

    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: Any) -> None:
        """Record the lifted stream context and audio bytes."""
        audio = b"".join([chunk async for chunk in chunks])
        self.calls.append(("audio", (audio, stream)))

    async def interrupt(self, session_id: str, reason: str) -> None:
        """Record an interruption."""
        self.calls.append(("interrupt", (session_id, reason)))

    async def close_session(self, session_id: str) -> None:
        """Record session cleanup."""
        self.calls.append(("close", session_id))


async def _chunks() -> AsyncIterator[bytes]:
    yield b"first"
    yield b"second"


def test_composed_audio_sink_forwards_context_and_lifecycle() -> None:
    """The adapter carries composed metadata without changing the realtime adapter."""

    async def scenario() -> None:
        agent = RecordingAgent()
        sink = ComposedAgentAudioSink(agent)
        context = StreamContext(
            stream_id="stream_1",
            conversation_id="conversation_1",
            session=SessionContext("session_1", "account_1", "device_1", "Asia/Shanghai"),
            audio_config=AudioConfig("pcm_s16le", 16000, 1),
            request_id="request_1",
        )

        await sink.consume(_chunks(), context)
        await sink.interrupt("session_1", "user_interrupted")
        await sink.close_session("session_1")

        _, (audio, stream) = agent.calls[0]
        assert audio == b"firstsecond"
        assert stream.session_id == "session_1"
        assert stream.account_id == "account_1"
        assert stream.timezone == "Asia/Shanghai"
        assert stream.stream_id == "stream_1"
        assert stream.conversation_id == "conversation_1"
        assert stream.request_id == "request_1"
        assert stream.audio_format == "pcm_s16le"
        assert stream.sample_rate_hz == 16000
        assert stream.channels == 1
        assert agent.calls[1:] == [
            ("interrupt", ("session_1", "user_interrupted")),
            ("close", "session_1"),
        ]

    asyncio.run(scenario())
