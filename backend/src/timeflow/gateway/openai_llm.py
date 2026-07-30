"""OpenAI gateway adapter."""

from __future__ import annotations

import json
from typing import Any, Protocol, cast

from openai import AsyncOpenAI

from timeflow.business.voice import StructuredLLMPort, StructuredLLMResult


class OpenAISettings(Protocol):
    """Shape required by the OpenAI client."""

    base_url: str
    api_key: str
    model: str


class OpenAIResponseError(RuntimeError):
    """Raised when the model does not return usable content."""


class OpenAILLMClient(StructuredLLMPort):
    """Wrap OpenAI Responses API for text and structured extraction."""

    def __init__(self, settings: OpenAISettings) -> None:
        self._settings = settings
        self._client = AsyncOpenAI(api_key=settings.api_key, base_url=settings.base_url)

    async def generate_text(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> str:
        """Generate free-form text from a single prompt."""
        response = await self._client.responses.create(
            model=self._settings.model,
            input=cast(Any, self._build_input(prompt, system_prompt)),
            temperature=temperature,
        )
        text = response.output_text.strip()
        if not text:
            raise OpenAIResponseError("OpenAI returned empty text")
        return text

    async def generate_json(
        self,
        prompt: str,
        *,
        schema: dict[str, Any],
        response_name: str = "timeflow_response",
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> StructuredLLMResult:
        """Generate structured JSON that follows the provided schema."""
        response = await self._client.responses.create(
            model=self._settings.model,
            input=cast(Any, self._build_input(prompt, system_prompt)),
            temperature=temperature,
            text=cast(
                Any,
                {
                    "format": {
                        "type": "json_schema",
                        "name": response_name,
                        "schema": schema,
                        "strict": True,
                    }
                },
            ),
        )
        raw_text = response.output_text.strip()
        if not raw_text:
            raise OpenAIResponseError("OpenAI returned empty JSON text")

        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive guard
            raise OpenAIResponseError("OpenAI returned invalid JSON") from exc

        if not isinstance(payload, dict):
            raise OpenAIResponseError("OpenAI JSON response must be an object")

        return StructuredLLMResult(data=payload, raw_text=raw_text)

    async def aclose(self) -> None:
        """Release the underlying HTTP resources."""
        await self._client.close()

    @staticmethod
    def _build_input(prompt: str, system_prompt: str | None) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append(
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system_prompt}],
                }
            )
        messages.append(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            }
        )
        return messages


__all__ = ["OpenAILLMClient", "OpenAIResponseError", "OpenAISettings"]
