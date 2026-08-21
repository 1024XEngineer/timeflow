"""Provider-neutral Agent tool registry and dialogue-control definition."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from timeflow.business.calendar import ScheduleAgentService
from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.conversation.schedule_tools import (
    ScheduleResultObserver,
    build_schedule_tools,
)
from timeflow.intelligence.location import (
    ClientLocation,
    LocationSearchContext,
    LocationSearchService,
)


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
class _DialogueControlTool:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        del arguments
        raise RuntimeError(f"{self.definition.name} is handled by Agent")


def request_user_input_definition() -> ToolDefinition:
    """Return the strict schema for structured Agent questions."""
    return ToolDefinition(
        name="request_user_input",
        description=(
            "Ask exactly one short, natural-language question for the single most important "
            "missing field, disambiguation, recurrence scope, or confirmation. Never bundle "
            "multiple fields, choices, examples, or explanations into one question."
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
                    "description": (
                        "missing_field 缺必要信息；ambiguous_target 匹配到多条日程；"
                        "recurrence_scope 周期日程范围不明；confirmation 删除等不可逆操作前需用户确认"
                    ),
                },
                "speech_text": {
                    "type": "string",
                    "minLength": 1,
                    "description": "要问用户的话，一句口语，例如「这个会是哪天的？」",
                },
                "required_response": {
                    "type": ["string", "null"],
                    "description": "希望用户补充的字段名，例如 start_time、location",
                },
                "candidates": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "匹配到多条日程时的候选，供客户端展示；ambiguous_target 必填",
                },
            },
            "required": ["question_kind", "speech_text"],
            "additionalProperties": False,
        },
    )


def end_conversation_definition() -> ToolDefinition:
    """Return the client-visible continuous-conversation termination tool."""
    return ToolDefinition(
        name="end_conversation",
        description=(
            "Call when the user explicitly wants to end the current voice conversation. "
            "A brief farewell may be spoken before calling; do not continue afterward."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )


def build_agent_tool_registry(
    schedule_service: ScheduleAgentService,
    account_id: str,
    observer: ScheduleResultObserver | None = None,
    *,
    location_service: LocationSearchService | None = None,
    location_context: LocationSearchContext | None = None,
    client_location: ClientLocation | None = None,
) -> ToolRegistry:
    """Build the authenticated PR 2 tool registry."""
    return ToolRegistry(
        [
            *build_schedule_tools(
                schedule_service,
                account_id,
                observer,
                location_service=location_service,
                location_context=location_context,
                client_location=client_location,
            ),
            _DialogueControlTool(request_user_input_definition()),
            _DialogueControlTool(end_conversation_definition()),
        ]
    )


__all__ = [
    "Tool",
    "ToolRegistry",
    "build_agent_tool_registry",
    "end_conversation_definition",
    "request_user_input_definition",
]
