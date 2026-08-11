"""Agent tool registry and placeholder behavior tests."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

import pytest

from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.conversation.tools import ToolRegistry, build_default_tool_registry


@dataclass(frozen=True, slots=True)
class FakeTool:
    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        return json.dumps({"arguments": dict(arguments)}, ensure_ascii=False)


def test_registry_rejects_duplicate_names() -> None:
    definition = ToolDefinition("same", "same", {"type": "object"})

    with pytest.raises(ValueError, match="Duplicate tool name: same"):
        ToolRegistry([FakeTool(definition), FakeTool(definition)])


def test_registry_raises_key_error_for_unknown_name() -> None:
    with pytest.raises(KeyError):
        ToolRegistry([]).get("missing")


def test_default_tool_definitions_have_unique_expected_names() -> None:
    registry = build_default_tool_registry()
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool_name",
    ["schedule_create", "schedule_query", "schedule_update", "schedule_delete"],
)
async def test_schedule_placeholders_do_not_fake_success(tool_name: str) -> None:
    tool = build_default_tool_registry().get(tool_name)

    result = json.loads(await tool.execute({"title": "开会"}))

    assert result == {
        "message": "日程业务服务尚未接入",
        "status": "not_implemented",
        "tool": tool_name,
    }
    assert "schedule_id" not in result
    assert "success" not in result


@pytest.mark.asyncio
async def test_location_placeholder_does_not_fake_candidates() -> None:
    tool = build_default_tool_registry().get("location_search")

    result = json.loads(await tool.execute({"query": "万达广场"}))

    assert result == {
        "message": "地图地点搜索服务尚未接入",
        "status": "not_implemented",
        "tool": "location_search",
    }
    assert not {"candidates", "latitude", "longitude", "address"} & result.keys()


def test_request_user_input_definition_has_strict_control_schema() -> None:
    definition = build_default_tool_registry().get("request_user_input").definition
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
    tool = build_default_tool_registry().get("request_user_input")

    with pytest.raises(RuntimeError, match="handled by Agent"):
        await tool.execute({})
