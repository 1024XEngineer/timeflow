"""OpenAI-compatible streaming LLM adapter."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from typing import Any, Protocol, cast

from openai import AsyncOpenAI

from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
    LlmEvent,
    LlmMessage,
    LlmPort,
    LlmProtocolError,
    LlmProviderError,
    LlmStreamCompleted,
    LlmUsage,
    TextDelta,
    ToolCallDelta,
    ToolDefinition,
    ToolResultMessage,
)


class _Client(Protocol):
    chat: Any


def _message_payload(message: LlmMessage) -> dict[str, object]:
    if isinstance(message, ChatMessage):
        return {"role": message.role, "content": message.content}
    if isinstance(message, AssistantToolCallMessage):
        return {
            "role": "assistant",
            "content": message.content,
            "tool_calls": [
                {
                    "id": call.call_id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in message.tool_calls
            ],
        }
    if isinstance(message, ToolResultMessage):
        return {
            "role": "tool",
            "tool_call_id": message.tool_call_id,
            "content": message.content,
        }
    raise TypeError(f"Unsupported LLM message: {type(message).__name__}")


def _tool_payload(definition: ToolDefinition) -> dict[str, object]:
    return {
        "type": "function",
        "function": {
            "name": definition.name,
            "description": definition.description,
            "parameters": dict(definition.parameters),
        },
    }


class OpenAICompatibleLlm(LlmPort):
    """Stream provider-neutral events from an OpenAI-compatible endpoint."""

    def __init__(self, settings: Settings, client: _Client | None = None) -> None:
        self._settings = settings
        self._client = client or cast(
            _Client,
            AsyncOpenAI(
                api_key=settings.openai_api_key or "not-configured",
                base_url=settings.openai_base_url or None,
                timeout=settings.openai_timeout_seconds,
            ),
        )

    def stream(
        self,
        messages: Sequence[LlmMessage],
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[LlmEvent]:
        return self._stream(messages, tools)

    async def _stream(
        self,
        messages: Sequence[LlmMessage],
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[LlmEvent]:
        self._validate_settings()
        stream: Any = None
        usage: LlmUsage | None = None
        finish_reason: str | None = None
        try:
            stream = await self._client.chat.completions.create(
                model=self._settings.openai_model,
                messages=[_message_payload(message) for message in messages],
                tools=[_tool_payload(tool) for tool in tools],
                stream=True,
                stream_options={"include_usage": True},
                extra_body={"enable_thinking": False},
                parallel_tool_calls=False,
                tool_choice="auto",
            )
            async for chunk in stream:
                choices = getattr(chunk, "choices", None)
                if not isinstance(choices, list):
                    raise LlmProtocolError("LLM chunk choices must be a list")
                chunk_usage = getattr(chunk, "usage", None)
                if not choices:
                    if chunk_usage is not None:
                        usage = self._parse_usage(chunk_usage)
                    continue
                choice = choices[0]
                finish_value = getattr(choice, "finish_reason", None)
                if finish_value is not None and not isinstance(finish_value, str):
                    raise LlmProtocolError("LLM finish reason must be a string")
                if finish_value is not None:
                    finish_reason = finish_value
                delta = getattr(choice, "delta", None)
                if delta is None:
                    raise LlmProtocolError("LLM choice delta is missing")
                content = getattr(delta, "content", None)
                if content is not None and not isinstance(content, str):
                    raise LlmProtocolError("LLM text delta must be a string")
                if content:
                    yield TextDelta(content)
                tool_calls = getattr(delta, "tool_calls", None)
                if tool_calls is not None:
                    if not isinstance(tool_calls, list):
                        raise LlmProtocolError("LLM tool call deltas must be a list")
                    for call in tool_calls:
                        yield self._parse_tool_call_delta(call)
            yield LlmStreamCompleted(finish_reason, usage)
        except asyncio.CancelledError:
            raise
        except (LlmProtocolError, LlmProviderError):
            raise
        except Exception as exc:
            raise LlmProviderError("OpenAI-compatible LLM request failed") from exc
        finally:
            if stream is not None:
                close = getattr(stream, "close", None)
                if callable(close):
                    await close()

    def _validate_settings(self) -> None:
        if not self._settings.openai_base_url:
            raise LlmProviderError("OpenAI-compatible base URL is not configured")
        if not self._settings.openai_api_key:
            raise LlmProviderError("OpenAI-compatible API key is not configured")
        if not self._settings.openai_model:
            raise LlmProviderError("OpenAI-compatible model is not configured")

    @staticmethod
    def _parse_usage(raw_usage: object) -> LlmUsage:
        values = (
            getattr(raw_usage, "prompt_tokens", None),
            getattr(raw_usage, "completion_tokens", None),
            getattr(raw_usage, "total_tokens", None),
        )
        if any(
            not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in values
        ):
            raise LlmProtocolError("LLM usage fields must be non-negative integers")
        prompt_tokens, completion_tokens, total_tokens = cast(tuple[int, int, int], values)
        return LlmUsage(prompt_tokens, completion_tokens, total_tokens)

    @staticmethod
    def _parse_tool_call_delta(call: object) -> ToolCallDelta:
        index = getattr(call, "index", None)
        call_id = getattr(call, "id", None)
        function = getattr(call, "function", None)
        if function is None:
            raise LlmProtocolError("LLM tool call function is missing")
        name = getattr(function, "name", None)
        arguments = getattr(function, "arguments", None)
        if not isinstance(index, int) or isinstance(index, bool):
            raise LlmProtocolError("LLM tool call index must be an integer")
        if call_id is not None and not isinstance(call_id, str):
            raise LlmProtocolError("LLM tool call ID must be a string")
        if name is not None and not isinstance(name, str):
            raise LlmProtocolError("LLM tool call name must be a string")
        if not isinstance(arguments, str):
            raise LlmProtocolError("LLM tool call arguments must be a string")
        return ToolCallDelta(index, call_id or None, name or None, arguments)
