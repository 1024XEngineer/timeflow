"""Provider-neutral Agent tool registry and dialogue-control definition."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from timeflow.business.calendar import ScheduleAgentService
from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.conversation.schedule_tools import build_schedule_tools


class Tool(Protocol):
    """Executable Agent tool exposed to an LLM through a definition."""

    @property
    def definition(self) -> ToolDefinition:
        """Return the LLM-visible function definition."""

    async def execute(self, arguments: Mapping[str, object]) -> str:
        """Return content for a role=tool message."""


class ToolRegistry:
    """Ordered collection of uniquely named Agent tools."""

    def __init__(self, tools: Sequence[Tool]) -> None:
        by_name: dict[str, Tool] = {}
        for tool in tools:
            name = tool.definition.name
            if name in by_name:
                raise ValueError(f"Duplicate tool name: {name}")
            by_name[name] = tool
        self._by_name = by_name

    def get(self, name: str) -> Tool:
        """Return a registered tool by name."""
        return self._by_name[name]

    def definitions(self) -> tuple[ToolDefinition, ...]:
        """Return definitions in registration order."""
        return tuple(tool.definition for tool in self._by_name.values())


@dataclass(frozen=True, slots=True)
class _RequestUserInputTool:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        del arguments
        raise RuntimeError("request_user_input is handled by Agent")


def request_user_input_definition() -> ToolDefinition:
    """Return the strict schema for structured Agent questions."""
    return ToolDefinition(
        name="request_user_input",
        description=(
            "Ask the user for missing information, disambiguation, recurrence scope, "
            "or confirmation before continuing."
        ),
        parameters={
            "type": "object",
            "properties": {
                "question_kind": {
                    "type": "string",
                    "enum": [
                        "missing_field",
                        "ambiguous_target",
                        "recurrence_scope",
                        "confirmation",
                    ],
                },
                "speech_text": {"type": "string"},
                "required_response": {"type": "string"},
                "candidates": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "question_kind",
                "speech_text",
                "required_response",
                "candidates",
            ],
            "additionalProperties": False,
        },
    )


def build_agent_tool_registry(
    schedule_service: ScheduleAgentService,
    account_id: str,
) -> ToolRegistry:
    """Build the authenticated PR 2 tool registry."""
    return ToolRegistry(
        [
            *build_schedule_tools(schedule_service, account_id),
            _RequestUserInputTool(request_user_input_definition()),
        ]
    )


__all__ = [
    "Tool",
    "ToolRegistry",
    "build_agent_tool_registry",
    "request_user_input_definition",
]
