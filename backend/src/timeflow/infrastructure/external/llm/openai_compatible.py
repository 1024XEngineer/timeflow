"""OpenAI-compatible streaming LLM adapter."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from typing import Any, Protocol, cast

from openai import AsyncOpenAI, OpenAI

from timeflow.infrastructure.observability.external import ExternalCall
from timeflow.infrastructure.observability.metrics import LLM_TOKENS
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
    JsonLlmPort,
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


class _SyncClient(Protocol):
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
        call = ExternalCall("llm", "stream")
        try:
            stream = await self._client.chat.completions.create(
                model=self._settings.openai_model,
                messages=[_message_payload(message) for message in messages],
                tools=[_tool_payload(tool) for tool in tools],
                stream=True,
                stream_options={"include_usage": True},
                temperature=0.2,
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
                    call.mark_first_byte()
                    yield TextDelta(content)
                tool_calls = getattr(delta, "tool_calls", None)
                if tool_calls is not None:
                    if not isinstance(tool_calls, list):
                        raise LlmProtocolError("LLM tool call deltas must be a list")
                    call.mark_first_byte()
                    for call_delta in tool_calls:
                        yield self._parse_tool_call_delta(call_delta)
            if usage is not None:
                LLM_TOKENS.labels("stream", "prompt").inc(usage.prompt_tokens)
                LLM_TOKENS.labels("stream", "completion").inc(usage.completion_tokens)
            yield LlmStreamCompleted(finish_reason, usage)
        except asyncio.CancelledError:
            call.cancel()
            raise
        except LlmProtocolError:
            call.fail("protocol")
            raise
        except LlmProviderError:
            call.fail("provider")
            raise
        except Exception as exc:
            call.fail("provider")
            raise LlmProviderError("OpenAI-compatible LLM request failed") from exc
        finally:
            if stream is not None:
                close = getattr(stream, "close", None)
                if callable(close):
                    await close()
            call.__exit__(None, None, None)

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
        return ToolCallDelta(index, call_id or None, name or None, _tool_arguments_text(arguments))


def _tool_arguments_text(arguments: object) -> str:
    """Normalize one streamed tool-call arguments fragment to a string.

    OpenAI-compatible providers, including DashScope, often omit arguments on the
    first delta (null) or send a completed JSON object instead of a string. Those
    shapes still concatenate into valid JSON for the Agent accumulator.
    """
    if arguments is None:
        return ""
    if isinstance(arguments, str):
        return arguments
    if isinstance(arguments, (dict, list)):
        return json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
    raise LlmProtocolError("LLM tool call arguments must be a string")


class OpenAICompatibleJsonLlm(JsonLlmPort):
    """Complete one JSON-mode request through the configured compatible provider."""

    def __init__(
        self,
        settings: Settings,
        client: _SyncClient | None = None,
        *,
        timeout_seconds: float | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or cast(
            _SyncClient,
            OpenAI(
                api_key=settings.openai_api_key or "not-configured",
                base_url=settings.openai_base_url or None,
                timeout=(
                    timeout_seconds
                    if timeout_seconds is not None
                    else settings.openai_timeout_seconds
                ),
                max_retries=0,
            ),
        )

    def complete_json(self, messages: Sequence[ChatMessage]) -> str:
        self._validate_settings()
        with ExternalCall("llm", "json") as call:
            try:
                completion = self._client.chat.completions.create(
                    model=self._settings.openai_model,
                    messages=[_message_payload(message) for message in messages],
                    response_format={"type": "json_object"},
                    stream=False,
                )
                choices = getattr(completion, "choices", None)
                if not isinstance(choices, list) or len(choices) != 1:
                    raise LlmProtocolError("LLM JSON response must contain exactly one choice")
                message = getattr(choices[0], "message", None)
                content = None if message is None else getattr(message, "content", None)
                if not isinstance(content, str) or not content.strip():
                    raise LlmProtocolError("LLM JSON response content must be a non-empty string")
                usage = getattr(completion, "usage", None)
                if usage is not None:
                    prompt = getattr(usage, "prompt_tokens", 0)
                    completion_tokens = getattr(usage, "completion_tokens", 0)
                    if isinstance(prompt, int) and not isinstance(prompt, bool):
                        LLM_TOKENS.labels("json", "prompt").inc(prompt)
                    if isinstance(completion_tokens, int) and not isinstance(
                        completion_tokens, bool
                    ):
                        LLM_TOKENS.labels("json", "completion").inc(completion_tokens)
                return content
            except LlmProtocolError:
                call.fail("protocol")
                raise
            except LlmProviderError:
                call.fail("provider")
                raise
            except Exception as exc:
                call.fail("provider")
                raise LlmProviderError("OpenAI-compatible JSON request failed") from exc

    def _validate_settings(self) -> None:
        if not self._settings.openai_base_url:
            raise LlmProviderError("OpenAI-compatible base URL is not configured")
        if not self._settings.openai_api_key:
            raise LlmProviderError("OpenAI-compatible API key is not configured")
        if not self._settings.openai_model:
            raise LlmProviderError("OpenAI-compatible model is not configured")
