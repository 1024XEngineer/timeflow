"""Provider-neutral Agent tool definitions and placeholders."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from timeflow.intelligence.conversation.llm import ToolDefinition


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
class _PlaceholderTool:
    definition: ToolDefinition
    message: str

    async def execute(self, arguments: Mapping[str, object]) -> str:
        del arguments
        return json.dumps(
            {
                "message": self.message,
                "status": "not_implemented",
                "tool": self.definition.name,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )


@dataclass(frozen=True, slots=True)
class _RequestUserInputTool:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        del arguments
        raise RuntimeError("request_user_input is handled by Agent")


def _placeholder_definition(name: str, description: str) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=description,
        parameters={"type": "object", "additionalProperties": True},
    )


def _request_user_input_definition() -> ToolDefinition:
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


def build_default_tool_registry() -> ToolRegistry:
    """Build the six tools supported by the first Agent implementation."""
    schedule_message = "日程业务服务尚未接入"
    location_message = "地图地点搜索服务尚未接入"
    return ToolRegistry(
        [
            _PlaceholderTool(
                _placeholder_definition(
                    "schedule_create",
                    "Create a schedule. Never claim success without calling this tool.",
                ),
                schedule_message,
            ),
            _PlaceholderTool(
                _placeholder_definition(
                    "schedule_query",
                    "Query schedules before selecting, updating, or deleting one.",
                ),
                schedule_message,
            ),
            _PlaceholderTool(
                _placeholder_definition(
                    "schedule_update",
                    "Update a schedule after its target and recurrence scope are clear.",
                ),
                schedule_message,
            ),
            _PlaceholderTool(
                _placeholder_definition(
                    "schedule_delete",
                    "Delete a schedule only after explicit user confirmation.",
                ),
                schedule_message,
            ),
            _PlaceholderTool(
                _placeholder_definition(
                    "location_search",
                    "Search for a location instead of inventing an address or coordinates.",
                ),
                location_message,
            ),
            _RequestUserInputTool(_request_user_input_definition()),
        ]
    )
