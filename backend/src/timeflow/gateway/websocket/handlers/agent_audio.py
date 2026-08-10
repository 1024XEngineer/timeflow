"""Audio sink that forwards an inbound stream to the dialogue agent unchanged."""

from collections.abc import AsyncIterator
from dataclasses import dataclass

from timeflow.gateway.websocket.agent_ports import Agent
from timeflow.gateway.websocket.ports import StreamContext


@dataclass(frozen=True, slots=True)
class _StreamIdentity:
    """Identifiers lifted out of a stream context for the agent."""

    session_id: str
    stream_id: str
    conversation_id: str
    request_id: str | None


class AgentAudioSink:
    """Hand each inbound stream to the agent as raw audio."""

    def __init__(self, agent: Agent) -> None:
        """Store the agent that receives the audio."""
        self._agent = agent

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Forward the stream unchanged, then return once the agent has taken it."""
        await self._agent.handle_audio(chunks, _identity_of(stream))


def _identity_of(stream: StreamContext) -> _StreamIdentity:
    """Lift the identifiers the agent needs out of the transport's context."""
    return _StreamIdentity(
        session_id=stream.session.session_id,
        stream_id=stream.stream_id,
        conversation_id=stream.conversation_id,
        request_id=stream.request_id,
    )
