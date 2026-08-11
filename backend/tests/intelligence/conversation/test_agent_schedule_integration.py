"""Agent-to-schedule-service end-to-end Function Calling test."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime

import pytest

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    ScheduleAgentService,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    UpdateScheduleCommand,
)
from timeflow.intelligence.conversation.agent import (
    Agent,
    AgentCompleted,
    AgentConversation,
    AgentTextDelta,
)
from timeflow.intelligence.conversation.llm import (
    LlmEvent,
    LlmMessage,
    LlmStreamCompleted,
    LlmUsage,
    TextDelta,
    ToolCallDelta,
    ToolDefinition,
    ToolResultMessage,
)
from timeflow.intelligence.conversation.tools import build_agent_tool_registry


class CreatingScheduleService(ScheduleAgentService):
    def __init__(self) -> None:
        self.account_id: str | None = None
        self.command: CreateScheduleCommand | None = None

    def create_schedule(
        self, *, account_id: str, command: CreateScheduleCommand
    ) -> ScheduleMutationResult:
        self.account_id = account_id
        self.command = command
        now = datetime(2026, 8, 12, 7, tzinfo=UTC)
        return ScheduleMutationResult(
            schedules=(
                ScheduleSnapshot(
                    id="schedule-created",
                    account_id=account_id,
                    schedule_type=command.schedule_type,
                    schedule_kind=command.schedule_kind,
                    title=command.title,
                    is_all_day=command.is_all_day,
                    timezone=command.timezone,
                    status=ScheduleStatus.ACTIVE,
                    revision=1,
                    created_at=now,
                    updated_at=now,
                    start_time=command.start_time,
                ),
            )
        )

    def find_schedules(self, *, account_id: str, query: FindSchedulesQuery) -> ScheduleSearchResult:
        raise AssertionError((account_id, query))

    def update_schedule(
        self, *, account_id: str, command: UpdateScheduleCommand
    ) -> ScheduleMutationResult:
        raise AssertionError((account_id, command))

    def delete_once_schedule(
        self, *, account_id: str, command: DeleteOnceScheduleCommand
    ) -> ScheduleMutationResult:
        raise AssertionError((account_id, command))

    def delete_recurring_schedule(
        self, *, account_id: str, command: DeleteRecurringScheduleCommand
    ) -> ScheduleMutationResult:
        raise AssertionError((account_id, command))


class CreateThenAnswerLlm:
    def __init__(self) -> None:
        self.requests: list[tuple[LlmMessage, ...]] = []

    def stream(
        self,
        messages: Sequence[LlmMessage],
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[LlmEvent]:
        self.requests.append(tuple(messages))
        assert tuple(definition.name for definition in tools) == (
            "schedule_create",
            "schedule_query",
            "schedule_update",
            "schedule_delete",
            "location_search",
            "request_user_input",
        )

        async def generate() -> AsyncIterator[LlmEvent]:
            if len(self.requests) == 1:
                arguments = json.dumps(
                    {
                        "schedule_type": "time",
                        "schedule_kind": "once",
                        "title": "项目同步",
                        "timezone": "Asia/Shanghai",
                        "is_all_day": False,
                        "start_time": "2026-08-12T15:00:00+08:00",
                    },
                    ensure_ascii=False,
                )
                midpoint = len(arguments) // 2
                yield ToolCallDelta(0, "call-create", "schedule_create", arguments[:midpoint])
                yield ToolCallDelta(0, None, None, arguments[midpoint:])
                yield LlmStreamCompleted("tool_calls", LlmUsage(10, 5, 15))
                return
            assert isinstance(messages[-1], ToolResultMessage)
            tool_result = json.loads(messages[-1].content)
            assert tool_result["status"] == "ok"
            assert tool_result["result"]["schedules"][0]["id"] == "schedule-created"
            yield TextDelta("已创建项目同步日程。")
            yield LlmStreamCompleted("stop", LlmUsage(20, 6, 26))

        return generate()


@pytest.mark.asyncio
async def test_agent_maps_tool_arguments_calls_service_and_returns_final_text() -> None:
    service = CreatingScheduleService()
    llm = CreateThenAnswerLlm()
    agent = Agent(llm, build_agent_tool_registry(service, "account-authenticated"))

    events = [event async for event in agent.run_turn(AgentConversation(), "明天下午三点项目同步")]

    assert events == [
        AgentTextDelta("已创建项目同步日程。"),
        AgentCompleted(LlmUsage(30, 11, 41)),
    ]
    assert service.account_id == "account-authenticated"
    assert service.command is not None
    assert service.command.schedule_type is ScheduleType.TIME
    assert service.command.schedule_kind is ScheduleKind.ONCE
    assert service.command.title == "项目同步"
    assert service.command.start_time is not None
    assert service.command.start_time.isoformat() == "2026-08-12T15:00:00+08:00"
