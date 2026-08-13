"""Schedule Agent tool schema, mapping, and service-call tests."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
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
from timeflow.intelligence.location import (
    Coordinate,
    CurrentArea,
    LocationSearchContext,
    LocationSearchService,
    ProviderLocationCandidate,
)


class _FakeLocationPort:
    """Return scripted provider candidates, mirroring tests/intelligence/location's fake."""

    def __init__(self, candidates: tuple[ProviderLocationCandidate, ...] = ()) -> None:
        self.candidates = candidates
        self.queries: list[str] = []

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        return CurrentArea("上海市", "上海市")

    async def search(
        self, query: str, context: LocationSearchContext
    ) -> tuple[ProviderLocationCandidate, ...]:
        self.queries.append(query)
        return self.candidates


def _location_context() -> LocationSearchContext:
    return LocationSearchContext(
        CurrentArea("上海市", "上海市"),
        Coordinate(31.22846, 121.47822, "gcj02"),
        "gcj02",
    )


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

    # location_search is not among these: its canonical definition lives in
    # intelligence.location.tools, shared with the Realtime Agent -- see
    # test_the_registered_location_search_matches_the_shared_definition below.
    assert set(definitions) == {
        "schedule_create",
        "schedule_query",
        "schedule_update",
        "schedule_delete",
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


def test_create_accepts_a_quoted_number_for_latitude_longitude_and_offset_minutes() -> None:
    """See the Realtime Agent's identical test: the model sometimes quotes a
    long-precision coordinate when copying it verbatim from a location_search candidate.
    """
    command = map_create_schedule_command(
        {
            **create_arguments(),
            "latitude": "31.187830664332115",
            "longitude": "121.60552031564809",
            "reminder_offset_minutes": "0",
        }
    )
    assert command.latitude == 31.187830664332115
    assert command.longitude == 121.60552031564809
    assert command.reminder_offset_minutes == 0


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


def test_update_maps_every_editable_field_without_dropping_explicit_nulls() -> None:
    command = map_update_schedule_command(
        {
            "schedule_id": "schedule-1",
            "expected_revision": 0,
            "changes": {
                "title": "新标题",
                "is_all_day": True,
                "start_time": "2026-08-12T00:00:00Z",
                "end_time": None,
                "timezone": "UTC",
                "recurrence_rule": None,
                "location_name": None,
                "latitude": 31,
                "longitude": 121.5,
                "reminder_type": "at_time",
                "reminder_trigger_at": "2026-08-11T23:45:00+00:00",
                "reminder_offset_minutes": 0,
                "reminder_strength": "high",
            },
        }
    )

    assert command.changes == {
        "title": "新标题",
        "is_all_day": True,
        "start_time": datetime(2026, 8, 12, tzinfo=UTC),
        "end_time": None,
        "timezone": "UTC",
        "recurrence_rule": None,
        "location_name": None,
        "latitude": 31.0,
        "longitude": 121.5,
        "reminder_type": ReminderType.AT_TIME,
        "reminder_trigger_at": datetime(2026, 8, 11, 23, 45, tzinfo=UTC),
        "reminder_offset_minutes": 0,
        "reminder_strength": ReminderStrength.HIGH,
    }


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


@pytest.mark.parametrize(
    ("mapper", "arguments", "message"),
    [
        (map_create_schedule_command, {**create_arguments(), "title": " "}, "title"),
        (map_create_schedule_command, {**create_arguments(), "is_all_day": 0}, "is_all_day"),
        (
            map_create_schedule_command,
            {**create_arguments(), "recurrence_rule": 1},
            "recurrence_rule",
        ),
        (
            map_create_schedule_command,
            {**create_arguments(), "reminder_offset_minutes": -1},
            "reminder_offset_minutes",
        ),
        (
            map_create_schedule_command,
            {**create_arguments(), "reminder_offset_minutes": True},
            "reminder_offset_minutes",
        ),
        (map_create_schedule_command, {**create_arguments(), "latitude": True}, "latitude"),
        (map_create_schedule_command, {**create_arguments(), "start_time": 1}, "start_time"),
        (
            map_create_schedule_command,
            {**create_arguments(), "start_time": "not-a-datetime"},
            "start_time",
        ),
        (map_create_schedule_command, {**create_arguments(), "schedule_type": 1}, "schedule_type"),
        (
            map_create_schedule_command,
            {**create_arguments(), "schedule_type": "invented"},
            "schedule_type",
        ),
        (map_create_schedule_command, {**create_arguments(), "reminder_type": 1}, "reminder_type"),
        (
            map_create_schedule_command,
            {**create_arguments(), "reminder_type": "invented"},
            "reminder_type",
        ),
        (map_find_schedules_query, {"include_deleted": 0}, "include_deleted"),
        (
            map_delete_schedule_command,
            {"schedule_id": "schedule-1", "expected_revision": True, "schedule_kind": "once"},
            "expected_revision",
        ),
        (
            map_update_schedule_command,
            {"schedule_id": "schedule-1", "expected_revision": 1, "changes": []},
            "changes",
        ),
        (
            map_update_schedule_command,
            {"schedule_id": "schedule-1", "expected_revision": 1, "changes": {}},
            "changes",
        ),
        (
            map_update_schedule_command,
            {"schedule_id": "schedule-1", "expected_revision": 1, "changes": {"id": "x"}},
            "Unexpected fields",
        ),
    ],
)
def test_mapping_rejects_each_invalid_primitive_at_the_boundary(
    mapper: Callable[[Mapping[str, object]], object],
    arguments: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ScheduleToolInputError, match=message):
        mapper(arguments)


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
@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected_operation", "command_type"),
    [
        ("schedule_query", {"title": "项目"}, "query", FindSchedulesQuery),
        (
            "schedule_update",
            {"schedule_id": "schedule-1", "expected_revision": 1, "changes": {"title": "新"}},
            "update",
            UpdateScheduleCommand,
        ),
        (
            "schedule_delete",
            {"schedule_id": "schedule-1", "expected_revision": 1, "schedule_kind": "once"},
            "delete_once",
            DeleteOnceScheduleCommand,
        ),
        (
            "schedule_delete",
            {
                "schedule_id": "schedule-1",
                "expected_revision": 1,
                "schedule_kind": "recurring",
                "scope": "entire_series",
            },
            "delete_recurring",
            DeleteRecurringScheduleCommand,
        ),
    ],
)
async def test_registry_dispatches_each_schedule_tool_to_its_business_operation(
    tool_name: str,
    arguments: dict[str, object],
    expected_operation: str,
    command_type: type[object],
) -> None:
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get(tool_name)

    result = json.loads(await tool.execute(arguments))

    operation, account_id, command = service.calls[0]
    assert (operation, account_id) == (expected_operation, "account-1")
    assert isinstance(command, command_type)
    assert result["status"] == "ok"


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
async def test_location_search_degrades_to_provider_unavailable_without_a_location() -> None:
    """No location_service/location_context given -- the same rule the Realtime Agent
    follows -- so location_search reports itself unavailable rather than being absent.
    """
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get("location_search")

    result = json.loads(await tool.execute({"query": "万达广场"}))

    assert result == {"status": "provider_unavailable", "candidates": []}
    assert service.calls == []


@pytest.mark.asyncio
async def test_location_search_returns_real_candidates_when_configured() -> None:
    """Given both a location_service and a prepared context, location_search searches
    for real -- proving Composed Agent wiring reuses the same module the Realtime Agent
    does, not a reimplementation.
    """
    candidate = ProviderLocationCandidate(
        "poi-1",
        "万达广场",
        "银川路 100 号",
        "商场",
        Coordinate(31.23, 121.48, "gcj02"),
        "上海市",
        "上海市",
        "闵行区",
    )
    location_service = LocationSearchService(_FakeLocationPort((candidate,)))
    tool = build_agent_tool_registry(
        FakeScheduleService(),
        "account-1",
        location_service=location_service,
        location_context=_location_context(),
    ).get("location_search")

    result = json.loads(await tool.execute({"query": "万达广场"}))

    assert result["status"] == "ok"
    assert [item["name"] for item in result["candidates"]] == ["万达广场"]


def test_the_registered_location_search_matches_the_shared_definition() -> None:
    """The Function schema exposed here is exactly location_search_definition() -- no
    nearby_latitude/nearby_longitude leak, query-only, matching the Realtime Agent's copy.
    """
    from timeflow.intelligence.location import location_search_definition

    registered = build_agent_tool_registry(FakeScheduleService(), "account-1").get(
        "location_search"
    )

    assert registered.definition == location_search_definition()


def test_account_id_must_come_from_authenticated_context() -> None:
    with pytest.raises(ValueError, match="account_id"):
        build_agent_tool_registry(FakeScheduleService(), "")


@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected_call"),
    [
        ("schedule_query", {"title": "项目同步"}, "query"),
        (
            "schedule_update",
            {"schedule_id": "schedule-1", "expected_revision": 1, "changes": {"title": "改过的"}},
            "update",
        ),
        (
            "schedule_delete",
            {"schedule_id": "schedule-1", "expected_revision": 1, "schedule_kind": "once"},
            "delete_once",
        ),
        (
            "schedule_delete",
            {
                "schedule_id": "schedule-1",
                "expected_revision": 1,
                "schedule_kind": "recurring",
                "scope": "entire_series",
            },
            "delete_recurring",
        ),
    ],
)
@pytest.mark.asyncio
async def test_each_tool_reaches_the_service_call_that_matches_it(
    tool_name: str, arguments: dict[str, object], expected_call: str
) -> None:
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get(tool_name)

    result = json.loads(await tool.execute(arguments))

    assert [call for call, _, _ in service.calls] == [expected_call]
    assert result["status"] == "ok"


@pytest.mark.asyncio
async def test_a_tool_whose_arguments_do_not_map_reports_the_reason() -> None:
    service = FakeScheduleService()
    tool = build_agent_tool_registry(service, "account-1").get("schedule_update")

    with pytest.raises(ScheduleToolInputError):
        await tool.execute({"schedule_id": "schedule-1", "expected_revision": 1})

    assert service.calls == []
