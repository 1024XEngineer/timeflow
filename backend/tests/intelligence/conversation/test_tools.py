"""Agent tool registry and dialogue-control behavior tests."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

import pytest

from timeflow.business.calendar import ScheduleAgentService
from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.conversation.tools import (
    ToolRegistry,
    build_agent_tool_registry,
    request_user_input_definition,
)


@dataclass(frozen=True, slots=True)
class FakeTool:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        return json.dumps({"arguments": dict(arguments)}, ensure_ascii=False)


class EmptyScheduleService(ScheduleAgentService):
    def create_schedule(self, **kwargs: object) -> object:
        raise AssertionError(kwargs)

    def find_schedules(self, **kwargs: object) -> object:
        raise AssertionError(kwargs)

    def update_schedule(self, **kwargs: object) -> object:
        raise AssertionError(kwargs)

    def delete_once_schedule(self, **kwargs: object) -> object:
        raise AssertionError(kwargs)

    def delete_recurring_schedule(self, **kwargs: object) -> object:
        raise AssertionError(kwargs)


def test_registry_rejects_duplicate_names() -> None:
    definition = ToolDefinition("same", "same", {"type": "object"})

    with pytest.raises(ValueError, match="Duplicate tool name: same"):
        ToolRegistry([FakeTool(definition), FakeTool(definition)])


def test_registry_raises_key_error_for_unknown_name() -> None:
    with pytest.raises(KeyError):
        ToolRegistry([]).get("missing")


def test_agent_tool_definitions_have_unique_expected_names() -> None:
    registry = build_agent_tool_registry(EmptyScheduleService(), "account-1")
    names = tuple(definition.name for definition in registry.definitions())

    assert names == (
        "schedule_create",
        "schedule_query",
        "schedule_update",
        "schedule_delete",
        "location_search",
        "request_user_input",
    )
    assert len(names) == len(set(names))


def test_request_user_input_definition_has_strict_control_schema() -> None:
    definition = request_user_input_definition()
    properties = definition.parameters["properties"]

    assert definition.name == "request_user_input"
    assert definition.parameters["type"] == "object"
    assert definition.parameters["required"] == [
        "question_kind",
        "speech_text",
        "required_response",
        "candidates",
    ]
    assert definition.parameters["additionalProperties"] is False
    assert isinstance(properties, dict)
    question_kind = properties["question_kind"]
    assert isinstance(question_kind, dict)
    assert question_kind["enum"] == [
        "missing_field",
        "ambiguous_target",
        "recurrence_scope",
        "confirmation",
    ]


@pytest.mark.asyncio
async def test_request_user_input_is_not_executed_as_a_regular_tool() -> None:
    tool = build_agent_tool_registry(EmptyScheduleService(), "account-1").get("request_user_input")

    with pytest.raises(RuntimeError, match="handled by Agent"):
        await tool.execute({})
