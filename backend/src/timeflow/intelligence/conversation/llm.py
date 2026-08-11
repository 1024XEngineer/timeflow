"""Provider-neutral LLM types for the intelligence layer."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """A regular provider-neutral chat message."""

    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True, slots=True)
class ToolCall:
    """A complete tool call assembled from streamed deltas."""

    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True, slots=True)
class AssistantToolCallMessage:
    """An assistant message containing complete tool calls."""

    content: str
    tool_calls: tuple[ToolCall, ...]


@dataclass(frozen=True, slots=True)
class ToolResultMessage:
    """A tool result sent back to the model."""

    tool_call_id: str
    content: str


LlmMessage: TypeAlias = ChatMessage | AssistantToolCallMessage | ToolResultMessage


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """An LLM-visible function definition."""

    name: str
    description: str
    parameters: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class TextDelta:
    """A non-empty increment of model-generated text."""

    text: str


@dataclass(frozen=True, slots=True)
class ToolCallDelta:
    """An increment of a streamed tool call."""

    index: int
    call_id: str | None
    name: str | None
    arguments: str


@dataclass(frozen=True, slots=True)
class LlmUsage:
    """Token usage reported for one provider request."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True, slots=True)
class LlmStreamCompleted:
    """The terminal event for one provider stream."""

    finish_reason: str | None
    usage: LlmUsage | None


LlmEvent: TypeAlias = TextDelta | ToolCallDelta | LlmStreamCompleted


class LlmPort(Protocol):
    """Provider-neutral interface for one streaming model request."""

    def stream(
        self,
        messages: Sequence[LlmMessage],
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[LlmEvent]:
        """Stream one provider-neutral model response."""


class LlmError(Exception):
    """Base class for provider-neutral LLM failures."""


class LlmProviderError(LlmError):
    """The external provider request failed."""


class LlmProtocolError(LlmError):
    """The provider returned an invalid stream."""
