"""ToolBox routing, questions, and refusals, without a database behind them."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

from timeflow.business.calendar import (
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.intelligence.realtime.schedule_tools import ToolBox

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
    assert result.outcome is not None
    assert result.outcome["operation"] == "create_schedule"
    # The client is not told which account the row belongs to, nor when it was audited.
    assert "account_id" not in result.outcome["schedule"]
    assert "created_at" not in result.outcome["schedule"]


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
