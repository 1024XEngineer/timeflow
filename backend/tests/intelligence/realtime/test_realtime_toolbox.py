"""ToolBox routing, questions, and refusals, without a database behind them."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

from timeflow.business.calendar import (
    OccurrenceOverrideAction,
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.intelligence.location import (
    ClientLocation,
    Coordinate,
    CurrentArea,
    LocationConnectionError,
    LocationSearchContext,
    LocationSearchService,
    ProviderLocationCandidate,
)
from timeflow.intelligence.realtime.schedule_tools import ToolBox


class _FakeLocationPort:
    """Return scripted provider candidates, mirroring tests/intelligence/location's fake.

    reverse_failures counts down: that many reverse() calls raise before one succeeds,
    for exercising ToolBox's retry-on-the-next-call behavior.
    """

    def __init__(
        self,
        candidates: tuple[ProviderLocationCandidate, ...] = (),
        *,
        reverse_failures: int = 0,
    ) -> None:
        self.candidates = candidates
        self.queries: list[str] = []
        self._reverse_failures = reverse_failures
        self.reverse_calls = 0

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        self.reverse_calls += 1
        if self._reverse_failures > 0:
            self._reverse_failures -= 1
            raise LocationConnectionError("provider briefly unreachable")
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


def _client_location() -> ClientLocation:
    return ClientLocation(Coordinate(31.22846, 121.47822, "wgs84"))


SNAPSHOT = ScheduleSnapshot(
    id="sch_1",
    account_id="acc_test",
    schedule_type=ScheduleType.TIME,
    schedule_kind=ScheduleKind.ONCE,
    title="写周报",
    is_all_day=False,
    timezone="Asia/Shanghai",
    status=ScheduleStatus.ACTIVE,
    revision=1,
    created_at=datetime(2026, 9, 7, 1, 0, tzinfo=UTC),
    updated_at=datetime(2026, 9, 7, 1, 0, tzinfo=UTC),
    # 07:00 UTC is the instant 15:00 Asia/Shanghai names.
    start_time=datetime(2026, 9, 8, 7, 0, tzinfo=UTC),
)


class RecordingService(ScheduleAgentService):
    """Accept every call, remembering which one the ToolBox chose."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def create_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("create")
        return ScheduleMutationResult(schedules=(SNAPSHOT,))

    def find_schedules(self, *, account_id: str, query: Any) -> ScheduleSearchResult:
        self.calls.append("find")
        return ScheduleSearchResult(schedules=(SNAPSHOT,))

    def update_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("update")
        return ScheduleMutationResult(schedules=(SNAPSHOT,))

    def delete_once_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("delete_once")
        return ScheduleMutationResult(schedules=(SNAPSHOT,))

    def delete_recurring_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("delete_recurring")
        return ScheduleMutationResult(schedules=())


class RefusingService(ScheduleAgentService):
    """Refuse every call, the way the boundary does when a schedule is unacceptable."""

    def __init__(self, error: ScheduleBusinessError) -> None:
        self._error = error

    def create_schedule(self, *, account_id: str, command: Any) -> Any:
        raise self._error

    def find_schedules(self, *, account_id: str, query: Any) -> Any:
        raise self._error

    def update_schedule(self, *, account_id: str, command: Any) -> Any:
        raise self._error

    def delete_once_schedule(self, *, account_id: str, command: Any) -> Any:
        raise self._error

    def delete_recurring_schedule(self, *, account_id: str, command: Any) -> Any:
        raise self._error


def refusing_toolbox() -> ToolBox:
    return ToolBox(
        "acc_test",
        RefusingService(
            ScheduleBusinessError(
                code=ScheduleErrorCode.REVISION_CONFLICT,
                message="那条日程已经变了。",
                schedule_id="sch_1",
                field="expected_revision",
            )
        ),
    )


def run(name: str, arguments: dict[str, Any], box: ToolBox | None = None) -> Any:
    return asyncio.run((box or refusing_toolbox()).run(name, arguments))


def test_the_tool_schemas_are_handed_out_as_copies() -> None:
    box = refusing_toolbox()
    box.tools()[0]["type"] = "mutated"
    assert all(tool["type"] == "function" for tool in box.tools())


def test_every_registered_tool_has_a_name_and_parameters() -> None:
    for tool in refusing_toolbox().tools():
        assert tool["type"] == "function"
        assert tool["function"]["name"]
        assert tool["function"]["parameters"]["type"] == "object"


def test_schedule_create_schema_does_not_expose_category() -> None:
    schemas = {tool["function"]["name"]: tool for tool in refusing_toolbox().tools()}
    properties = schemas["schedule_create"]["function"]["parameters"]["properties"]

    assert set(properties) == {
        "schedule_type",
        "schedule_kind",
        "title",
        "is_all_day",
        "start_time",
        "end_time",
        "timezone",
        "recurrence_rule",
        "location_name",
        "latitude",
        "longitude",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "reminder_strength",
    }
    assert schemas["schedule_query"]["function"]["parameters"]["properties"]["category"] == {
        "type": ["string", "null"],
        "enum": [
            "work",
            "study",
            "exercise",
            "entertainment",
            "social",
            "rest",
            "personal",
            "other",
            None,
        ],
    }
    update_properties = schemas["schedule_update"]["function"]["parameters"]["properties"]
    assert "category" not in update_properties
    assert "category" not in update_properties["changes"]["properties"]
    assert "category" not in schemas["schedule_delete"]["function"]["parameters"]["properties"]


def test_a_tool_that_is_not_offered_is_refused() -> None:
    result = run("schedule_teleport", {})
    assert json.loads(result.output)["status"] == "failed"
    assert result.outcome is None


def test_an_unmappable_argument_is_refused_before_the_service_is_reached() -> None:
    result = run("schedule_create", {"schedule_type": "time", "schedule_kind": "once"})
    payload = json.loads(result.output)
    assert payload["status"] == "failed"
    assert "title" in payload["error"]["message"]
    assert result.outcome is None


@pytest.mark.parametrize(
    "name",
    ["schedule_create", "schedule_query", "schedule_update", "schedule_delete"],
)
def test_a_refused_write_tells_the_model_and_not_the_client(name: str) -> None:
    arguments: dict[str, Any] = {
        "schedule_create": {"schedule_type": "time", "schedule_kind": "once", "title": "写周报"},
        "schedule_query": {},
        "schedule_update": {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "changes": {"title": "改过的"},
        },
        "schedule_delete": {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "schedule_kind": "once",
        },
    }[name]
    result = run(name, arguments)
    payload = json.loads(result.output)
    assert payload["status"] == "failed"
    assert payload["error"]["code"] == "revision_conflict"
    assert payload["error"]["schedule_id"] == "sch_1"
    # No transaction committed, so there is no voice.command.result to send (protocol §5.5).
    assert result.outcome is None


def test_a_question_reaches_the_client_and_not_the_calendar() -> None:
    result = run(
        "request_user_input",
        {
            "question_kind": "missing_field",
            "speech_text": "  这个会是哪天的？  ",
            "required_response": "start_time",
        },
    )
    assert json.loads(result.output) == {"asked": True}
    assert result.question is not None
    assert result.question["speech_text"] == "这个会是哪天的？"
    assert result.question["required_response"] == "start_time"
    assert result.question["candidates"] == ()
    assert result.outcome is None


def test_an_ambiguous_target_carries_the_candidates_it_found() -> None:
    result = run(
        "request_user_input",
        {
            "question_kind": "ambiguous_target",
            "speech_text": "是哪一个会？",
            "candidates": [{"schedule_id": "sch_1"}, "not an object", {"schedule_id": "sch_2"}],
        },
    )
    assert result.question is not None
    # Anything that is not an object is dropped rather than passed to the client.
    assert result.question["candidates"] == ({"schedule_id": "sch_1"}, {"schedule_id": "sch_2"})


def test_an_ambiguous_target_with_nothing_to_choose_between_is_refused() -> None:
    result = run(
        "request_user_input",
        {"question_kind": "ambiguous_target", "speech_text": "是哪一个会？"},
    )
    assert json.loads(result.output)["status"] == "failed"
    assert result.question is None


def test_candidates_that_are_not_a_list_are_ignored() -> None:
    result = run(
        "request_user_input",
        {
            "question_kind": "missing_field",
            "speech_text": "哪天？",
            "candidates": "sch_1",
        },
    )
    assert result.question is not None
    assert result.question["candidates"] == ()


@pytest.mark.parametrize(
    "arguments",
    [
        {"question_kind": "telepathy", "speech_text": "哪天？"},
        {"speech_text": "哪天？"},
        {"question_kind": "missing_field"},
        {"question_kind": "missing_field", "speech_text": "   "},
        {"question_kind": "missing_field", "speech_text": 7},
    ],
)
def test_a_question_the_client_could_not_show_is_refused(arguments: dict[str, Any]) -> None:
    result = run("request_user_input", arguments)
    assert json.loads(result.output)["status"] == "failed"
    assert result.question is None
    assert result.outcome is None


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        ({"schedule_kind": "once"}, "delete_once"),
        ({"schedule_kind": "recurring", "scope": "entire_series"}, "delete_recurring"),
    ],
)
def test_a_delete_reaches_the_call_that_matches_the_kind(
    arguments: dict[str, Any], expected: str
) -> None:
    service = RecordingService()
    run(
        "schedule_delete",
        {"schedule_id": "sch_1", "expected_revision": 1, **arguments},
        ToolBox("acc_test", service),
    )
    assert service.calls == [expected]


OVERRIDE = ScheduleOccurrenceOverrideSnapshot(
    id="ovr_1",
    schedule_id="sch_1",
    occurrence_start=datetime(2026, 9, 8, 7, 0, tzinfo=UTC),
    action=OccurrenceOverrideAction.CANCEL,
    created_at=datetime(2026, 9, 7, 1, 0, tzinfo=UTC),
    updated_at=datetime(2026, 9, 7, 1, 0, tzinfo=UTC),
)


class OverrideProducingService(RecordingService):
    """A this_occurrence delete that cancels rather than replaces: no new schedule, one override."""

    def delete_recurring_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("delete_recurring")
        return ScheduleMutationResult(schedules=(), occurrence_overrides=(OVERRIDE,))


def test_a_this_occurrence_delete_reports_the_override_it_produced() -> None:
    result = run(
        "schedule_delete",
        {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "schedule_kind": "recurring",
            "scope": "this_occurrence",
        },
        ToolBox("acc_test", OverrideProducingService()),
    )
    assert result.outcome is not None
    assert result.outcome["schedule"] is None
    assert result.outcome["occurrence_overrides"] == [
        {
            "id": "ovr_1",
            "schedule_id": "sch_1",
            "occurrence_start": "2026-09-08T07:00:00+00:00",
            "action": "cancel",
            "replacement_schedule_id": None,
        }
    ]


class MultiScheduleProducingService(RecordingService):
    """A this_occurrence delete hitting an existing replace override: no new override,
    but two schedules — the untouched parent and the soft-deleted replacement."""

    def delete_recurring_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
        self.calls.append("delete_recurring")
        replacement = replace(SNAPSHOT, id="sch_replacement", status=ScheduleStatus.DELETED)
        return ScheduleMutationResult(schedules=(SNAPSHOT, replacement))


def test_a_this_occurrence_delete_with_existing_replacement_reports_both_schedules() -> None:
    result = run(
        "schedule_delete",
        {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "schedule_kind": "recurring",
            "scope": "this_occurrence",
        },
        ToolBox("acc_test", MultiScheduleProducingService()),
    )
    assert result.outcome is not None
    # schedule（单数）保持只给第一条，向后兼容
    assert result.outcome["schedule"]["id"] == "sch_1"
    # schedules（复数）必须两条都在，这是这次要修的东西——之前只有 schedules[0] 会下发，
    # 软删除的 replacement 永远到不了客户端
    ids = [s["id"] for s in result.outcome["schedules"]]
    assert ids == ["sch_1", "sch_replacement"]


def test_a_delete_with_nothing_left_to_report_still_says_it_applied() -> None:
    result = run(
        "schedule_delete",
        {
            "schedule_id": "sch_1",
            "expected_revision": 1,
            "schedule_kind": "recurring",
            "scope": "entire_series",
        },
        ToolBox("acc_test", RecordingService()),
    )
    assert json.loads(result.output) == {"status": "applied", "schedule": None}
    assert result.outcome is not None
    assert result.outcome["schedule"] is None


def test_a_committed_write_speaks_the_local_time_and_hides_the_audit_fields() -> None:
    result = run(
        "schedule_create",
        {"schedule_type": "time", "schedule_kind": "once", "title": "写周报"},
        ToolBox("acc_test", RecordingService()),
    )
    payload = json.loads(result.output)
    assert payload["status"] == "applied"
    assert payload["schedule"]["starts_at_local"] == "2026-09-08 15:00"
    assert "category" not in payload["schedule"]
    assert result.outcome is not None
    assert result.outcome["operation"] == "create_schedule"
    assert result.outcome["schedule"]["category"] is None
    # The client is not told which account the row belongs to, nor when it was audited.
    assert "account_id" not in result.outcome["schedule"]
    assert "created_at" not in result.outcome["schedule"]


def test_model_output_trims_internal_fields_but_keeps_speaking_fields() -> None:
    result = run(
        "schedule_create",
        {"schedule_type": "time", "schedule_kind": "once", "title": "写周报"},
        ToolBox("acc_test", RecordingService()),
    )
    schedule = json.loads(result.output)["schedule"]

    assert set(schedule) == {
        "id",
        "title",
        "schedule_type",
        "schedule_kind",
        "is_all_day",
        "start_time",
        "end_time",
        "recurrence_rule",
        "location_name",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "revision",
        "starts_at_local",
    }
    for field in (
        "account_id",
        "timezone",
        "status",
        "created_at",
        "updated_at",
        "deleted_at",
        "latitude",
        "longitude",
        "reminder_strength",
        "reminder_disposition_state",
        "category",
    ):
        assert field not in schedule


def test_a_schedule_without_a_start_time_speaks_no_local_time() -> None:
    class LocationService(RecordingService):
        def create_schedule(self, *, account_id: str, command: Any) -> ScheduleMutationResult:
            return ScheduleMutationResult(
                schedules=(
                    replace(
                        SNAPSHOT,
                        schedule_type=ScheduleType.LOCATION,
                        start_time=None,
                        location_name="公司",
                    ),
                )
            )

    result = run(
        "schedule_create",
        {"schedule_type": "location", "schedule_kind": "once", "title": "到公司"},
        ToolBox("acc_test", LocationService()),
    )
    assert json.loads(result.output)["schedule"]["starts_at_local"] == ""


def test_a_query_reports_what_it_found_to_both_sides() -> None:
    result = run("schedule_query", {}, ToolBox("acc_test", RecordingService()))
    payload = json.loads(result.output)
    assert payload["count"] == 1
    assert payload["schedules"][0]["starts_at_local"] == "2026-09-08 15:00"
    assert result.outcome is not None
    assert result.outcome["operation"] == "list_schedules"
    assert len(result.outcome["schedules"]) == 1


class _ManySchedulesService(RecordingService):
    """Return more matches than the model-facing output caps at."""

    def __init__(self, count: int) -> None:
        super().__init__()
        self._count = count

    def find_schedules(self, *, account_id: str, query: Any) -> ScheduleSearchResult:
        self.calls.append("find")
        return ScheduleSearchResult(
            schedules=tuple(replace(SNAPSHOT, id=f"sch_{i}") for i in range(self._count))
        )


def test_a_query_past_the_model_cap_is_truncated_for_the_model_but_not_the_client() -> None:
    """A voice query rarely needs more than a handful spoken back -- the model-facing
    output caps at MAX_SCHEDULES_FOR_MODEL, but the client still gets everything found.
    """
    result = run("schedule_query", {}, ToolBox("acc_test", _ManySchedulesService(25)))
    payload = json.loads(result.output)

    assert payload["count"] == 25
    assert len(payload["schedules"]) == 20
    assert payload["truncated"] is True
    assert payload["shown"] == 20
    assert result.outcome is not None
    assert len(result.outcome["schedules"]) == 25


def test_a_query_at_or_under_the_model_cap_is_not_marked_truncated() -> None:
    result = run("schedule_query", {}, ToolBox("acc_test", _ManySchedulesService(20)))
    payload = json.loads(result.output)

    assert payload["count"] == 20
    assert len(payload["schedules"]) == 20
    assert "truncated" not in payload


def test_a_blank_required_response_is_reported_as_absent() -> None:
    result = run(
        "request_user_input",
        {"question_kind": "confirmation", "speech_text": "确认删除？", "required_response": ""},
    )
    assert result.question is not None
    assert result.question["required_response"] is None


def test_ending_the_conversation_reaches_the_client_and_not_the_calendar() -> None:
    result = run("end_conversation", {})
    assert json.loads(result.output) == {"status": "ok"}
    assert result.ends_conversation is True
    assert result.outcome is None
    assert result.question is None


def test_every_other_tool_leaves_the_conversation_running() -> None:
    for tool in refusing_toolbox().tools():
        name = tool["function"]["name"]
        if name == "end_conversation":
            continue
        result = run(name, {})
        assert result.ends_conversation is False


def test_location_search_is_registered_alongside_the_schedule_tools() -> None:
    names = {tool["function"]["name"] for tool in refusing_toolbox().tools()}
    assert names == {
        "schedule_create",
        "schedule_query",
        "schedule_update",
        "schedule_delete",
        "request_user_input",
        "end_conversation",
        "location_search",
    }


def test_location_search_degrades_to_provider_unavailable_without_a_location_context() -> None:
    """No location_service/location_context given -- refusing_toolbox() supplies neither
    -- so location_search reports itself unavailable rather than being withheld from the
    schema (the model can always call it; it just may not always do anything).
    """
    result = run("location_search", {"query": "万达广场"})
    assert json.loads(result.output) == {"status": "provider_unavailable", "candidates": []}
    assert result.outcome is None


def test_location_search_returns_real_candidates_when_configured() -> None:
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
    box = ToolBox(
        "acc_test",
        RecordingService(),
        location_service=LocationSearchService(_FakeLocationPort((candidate,))),
        client_location=_client_location(),
    )

    result = run("location_search", {"query": "万达广场"}, box)

    payload = json.loads(result.output)
    assert payload["status"] == "ok"
    assert [item["name"] for item in payload["candidates"]] == ["万达广场"]


def test_location_search_bypasses_datetime_normalization() -> None:
    """A query containing a 'T'-like substring must reach the tool unmangled -- proving
    location_search is dispatched before normalize_datetime_args, unlike the schedule tools.
    """
    box = ToolBox(
        "acc_test",
        RecordingService(),
        location_service=LocationSearchService(_FakeLocationPort(())),
        client_location=_client_location(),
    )

    result = run("location_search", {"query": "2026-09-08T15:00 咖啡馆"}, box)

    payload = json.loads(result.output)
    assert payload["status"] == "ok"


def test_location_search_retries_a_failed_prepare_on_the_next_call() -> None:
    """A provider outage when the context is first needed must not disable
    location_search for the rest of a session that can hold for minutes -- unlike a
    successfully prepared context, a failed one is never remembered.
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
    port = _FakeLocationPort((candidate,), reverse_failures=1)
    box = ToolBox(
        "acc_test",
        RecordingService(),
        location_service=LocationSearchService(port),
        client_location=_client_location(),
    )

    first = json.loads(run("location_search", {"query": "万达广场"}, box).output)
    second = json.loads(run("location_search", {"query": "万达广场"}, box).output)

    assert first == {"status": "provider_unavailable", "candidates": []}
    assert second["status"] == "ok"
    assert [item["name"] for item in second["candidates"]] == ["万达广场"]
    assert port.reverse_calls == 2
