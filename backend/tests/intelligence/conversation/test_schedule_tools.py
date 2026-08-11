"""Schedule Agent tool schema, mapping, and service-call tests."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    RecurringDeleteScope,
    ReminderStrength,
    ReminderType,
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    UpdateScheduleCommand,
)
from timeflow.intelligence.conversation.schedule_tools import (
    ScheduleToolInputError,
    map_create_schedule_command,
    map_delete_schedule_command,
    map_find_schedules_query,
    map_update_schedule_command,
    schedule_tool_definitions,
)
from timeflow.intelligence.conversation.tools import build_agent_tool_registry


class FakeScheduleService(ScheduleAgentService):
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, object]] = []
        self.error: ScheduleBusinessError | None = None

    def _result(self, command: object) -> ScheduleMutationResult:
        if self.error is not None:
            raise self.error
        now = datetime(2026, 8, 12, 7, tzinfo=UTC)
        return ScheduleMutationResult(
            schedules=(
                ScheduleSnapshot(
                    id="schedule-1",
                    account_id="account-1",
                    schedule_type=ScheduleType.TIME,
                    schedule_kind=ScheduleKind.ONCE,
                    title=getattr(command, "title", "会议"),
                    is_all_day=False,
                    timezone="Asia/Shanghai",
                    status=ScheduleStatus.ACTIVE,
                    revision=1,
                    created_at=now,
                    updated_at=now,
                    start_time=now,
                ),
            )
        )

    def create_schedule(
        self, *, account_id: str, command: CreateScheduleCommand
    ) -> ScheduleMutationResult:
        self.calls.append(("create", account_id, command))
        return self._result(command)

    def find_schedules(self, *, account_id: str, query: FindSchedulesQuery) -> ScheduleSearchResult:
        self.calls.append(("query", account_id, query))
        result = self._result(query)
        return ScheduleSearchResult(result.schedules)

    def update_schedule(
        self, *, account_id: str, command: UpdateScheduleCommand
    ) -> ScheduleMutationResult:
        self.calls.append(("update", account_id, command))
        return self._result(command)

    def delete_once_schedule(
        self, *, account_id: str, command: DeleteOnceScheduleCommand
    ) -> ScheduleMutationResult:
        self.calls.append(("delete_once", account_id, command))
        return self._result(command)

    def delete_recurring_schedule(
        self, *, account_id: str, command: DeleteRecurringScheduleCommand
    ) -> ScheduleMutationResult:
        self.calls.append(("delete_recurring", account_id, command))
        return self._result(command)


def create_arguments() -> dict[str, object]:
    return {
        "schedule_type": "time",
        "schedule_kind": "recurring",
        "title": "项目同步",
        "timezone": "Asia/Shanghai",
        "is_all_day": False,
        "start_time": "2026-08-12T15:00:00+08:00",
        "end_time": None,
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=WE",
        "location_name": "203会议室",
        "latitude": 31.2304,
        "longitude": 121.4737,
        "reminder_type": "before_start",
        "reminder_trigger_at": None,
        "reminder_offset_minutes": 15,
        "reminder_strength": "medium",
    }


def test_definitions_match_business_contract_dimensions() -> None:
    definitions = {item.name: item for item in schedule_tool_definitions()}

    assert set(definitions) == {
        "schedule_create",
        "schedule_query",
        "schedule_update",
        "schedule_delete",
        "location_search",
    }
    create_properties = definitions["schedule_create"].parameters["properties"]
    assert isinstance(create_properties, dict)
    assert set(create_properties) == {
        "schedule_type",
        "schedule_kind",
        "title",
        "timezone",
        "is_all_day",
        "start_time",
        "end_time",
        "recurrence_rule",
        "location_name",
        "latitude",
        "longitude",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "reminder_strength",
    }
    assert definitions["schedule_create"].parameters["additionalProperties"] is False


def test_create_arguments_map_to_existing_business_command() -> None:
    command = map_create_schedule_command(create_arguments())

    assert command == CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.RECURRING,
        title="项目同步",
        timezone="Asia/Shanghai",
        is_all_day=False,
        start_time=datetime(2026, 8, 12, 15, tzinfo=datetime.now().astimezone().tzinfo).replace(
            tzinfo=command.start_time.tzinfo if command.start_time else None
        ),
        end_time=None,
        recurrence_rule="FREQ=WEEKLY;BYDAY=WE",
        location_name="203会议室",
        latitude=31.2304,
        longitude=121.4737,
        reminder_type=ReminderType.BEFORE_START,
        reminder_trigger_at=None,
        reminder_offset_minutes=15,
        reminder_strength=ReminderStrength.MEDIUM,
    )
    assert command.start_time is not None
    assert command.start_time.isoformat() == "2026-08-12T15:00:00+08:00"


def test_query_update_and_delete_arguments_map_to_business_contracts() -> None:
    query = map_find_schedules_query(
        {
            "title": "项目",
            "starts_at_or_after": "2026-08-12T00:00:00Z",
            "include_deleted": False,
        }
    )
    update = map_update_schedule_command(
        {
            "schedule_id": "schedule-1",
            "expected_revision": 3,
            "changes": {"title": "新标题", "location_name": None},
        }
    )
    delete_once = map_delete_schedule_command(
        {
            "schedule_id": "schedule-1",
            "expected_revision": 3,
            "schedule_kind": "once",
            "scope": None,
        }
    )
    delete_recurring = map_delete_schedule_command(
        {
            "schedule_id": "schedule-2",
            "expected_revision": 4,
            "schedule_kind": "recurring",
            "scope": "this_and_future",
        }
    )

    assert query.title == "项目"
    assert query.starts_at_or_after == datetime(2026, 8, 12, tzinfo=UTC)
    assert update == UpdateScheduleCommand(
        schedule_id="schedule-1",
        expected_revision=3,
        changes={"title": "新标题", "location_name": None},
    )
    assert delete_once == DeleteOnceScheduleCommand("schedule-1", 3)
    assert delete_recurring == DeleteRecurringScheduleCommand(
        "schedule-2", 4, RecurringDeleteScope.THIS_AND_FUTURE
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {**create_arguments(), "account_id": "attacker"},
        {**create_arguments(), "start_time": "2026-08-12T15:00:00"},
        {**create_arguments(), "latitude": 100},
    ],
)
def test_mapping_rejects_unsafe_or_invalid_arguments(arguments: dict[str, object]) -> None:
    with pytest.raises(ScheduleToolInputError):
        map_create_schedule_command(arguments)


def test_recurring_delete_requires_scope_and_once_rejects_it() -> None:
    with pytest.raises(ScheduleToolInputError, match="required"):
        map_delete_schedule_command(
            {
                "schedule_id": "schedule-1",
                "expected_revision": 1,
                "schedule_kind": "recurring",
            }
        )
    with pytest.raises(ScheduleToolInputError, match="only valid"):
        map_delete_schedule_command(
            {
                "schedule_id": "schedule-1",
                "expected_revision": 1,
                "schedule_kind": "once",
                "scope": "entire_series",
            }
        )


@pytest.mark.asyncio
async def test_registry_calls_service_with_injected_account_and_serializes_snapshot() -> None:
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get("schedule_create")

    result = json.loads(await tool.execute(create_arguments()))

    operation, account_id, command = service.calls[0]
    assert operation == "create"
    assert account_id == "account-1"
    assert isinstance(command, CreateScheduleCommand)
    assert result["status"] == "ok"
    assert result["result"]["schedules"][0]["id"] == "schedule-1"
    assert result["result"]["schedules"][0]["schedule_type"] == "time"
    assert result["result"]["schedules"][0]["start_time"] == "2026-08-12T07:00:00+00:00"


@pytest.mark.asyncio
async def test_business_error_is_returned_as_stable_tool_result() -> None:
    service = FakeScheduleService()
    service.error = ScheduleBusinessError(
        code=ScheduleErrorCode.REVISION_CONFLICT,
        message="The schedule revision is stale.",
        schedule_id="schedule-1",
        field="expected_revision",
    )
    tool = build_agent_tool_registry(service, "account-1").get("schedule_create")

    result = json.loads(await tool.execute(create_arguments()))

    assert result == {
        "status": "error",
        "error": {
            "code": "revision_conflict",
            "field": "expected_revision",
            "message": "The schedule revision is stale.",
            "schedule_id": "schedule-1",
        },
    }


@pytest.mark.asyncio
async def test_location_search_remains_truthful_placeholder() -> None:
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get("location_search")

    result = json.loads(await tool.execute({"query": "万达广场"}))

    assert result == {
        "message": "地图地点搜索服务尚未接入",
        "status": "not_implemented",
        "tool": "location_search",
    }
    assert service.calls == []


def test_account_id_must_come_from_authenticated_context() -> None:
    with pytest.raises(ValueError, match="account_id"):
        build_agent_tool_registry(FakeScheduleService(), "")
