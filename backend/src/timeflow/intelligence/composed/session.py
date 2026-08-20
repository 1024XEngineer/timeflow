"""Session-scoped state for the composed voice agent."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from timeflow.intelligence.conversation.agent import Agent, AgentConversation
from timeflow.intelligence.ports import StreamInfo

from .delivery import ScheduleResultDelivery


@dataclass(slots=True)
class ConversationState:
    """One retained Agent conversation and its account-bound executor."""

    conversation: AgentConversation
    agent: Agent
    result_delivery: ScheduleResultDelivery


@dataclass(slots=True)
class TurnState:
    """One agent-owned turn task identified by a monotonic generation."""

    generation: int
    task: asyncio.Task[None]


@dataclass(slots=True)
class ComposedSession:
    """Authenticated in-memory state retained until WebSocket disconnect."""

    session_id: str
    account_id: str
    timezone: str
    voice_mode: str
    generation: int = 0
    conversations: dict[str, ConversationState] = field(default_factory=dict)
    active_turn: TurnState | None = None
    active_audio_id: str | None = None
    active_audio_stream: StreamInfo | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
