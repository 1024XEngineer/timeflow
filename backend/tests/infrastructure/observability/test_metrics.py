"""Infrastructure Prometheus helpers and outbound call instruments."""

import asyncio

import pytest
from observability_support import metric_value

from timeflow.infrastructure.observability.external import ExternalCall
from timeflow.infrastructure.observability.metrics import (
    bound_db_operation,
    bound_dependency,
    bound_end_reason,
    bound_error_kind,
    bound_realtime_event,
    bound_session_stage,
    bound_stage,
    bound_status,
)


def test_sql_statements_are_classified_by_leading_keyword_only() -> None:
    assert bound_db_operation("SELECT id FROM schedules WHERE title = 'secret'") == "SELECT"
    assert bound_db_operation("insert into schedules") == "INSERT"
    assert bound_db_operation("VACUUM") == "OTHER"


def test_stage_names_drop_the_ms_suffix() -> None:
    assert bound_stage("asr_total_ms") == "asr_total"
    assert bound_stage("not_a_real_stage") == "other"


def test_external_call_records_success_without_payloads() -> None:
    before = metric_value(
        "timeflow_external_requests_total",
        {
            "dependency": "llm",
            "operation": "json",
            "status": "ok",
            "error_kind": "none",
        },
    )
    with ExternalCall("llm", "json") as call:
        call.mark_first_byte()

    assert (
        metric_value(
            "timeflow_external_requests_total",
            {
                "dependency": "llm",
                "operation": "json",
                "status": "ok",
                "error_kind": "none",
            },
        )
        == before + 1
    )


def test_external_call_maps_unknown_dependencies_to_other() -> None:
    before = metric_value(
        "timeflow_external_requests_total",
        {
            "dependency": "other",
            "operation": "other",
            "status": "error",
            "error_kind": "provider",
        },
    )
    with ExternalCall("secret-vendor", "leak-this-operation") as call:
        call.fail("provider")

    assert (
        metric_value(
            "timeflow_external_requests_total",
            {
                "dependency": "other",
                "operation": "other",
                "status": "error",
                "error_kind": "provider",
            },
        )
        == before + 1
    )


def test_external_call_classifies_timeout_without_message_text() -> None:
    before = metric_value(
        "timeflow_external_requests_total",
        {
            "dependency": "asr",
            "operation": "session",
            "status": "error",
            "error_kind": "timeout",
        },
    )
    try:
        with ExternalCall("asr", "session"):
            raise TimeoutError
    except TimeoutError:
        pass

    assert (
        metric_value(
            "timeflow_external_requests_total",
            {
                "dependency": "asr",
                "operation": "session",
                "status": "error",
                "error_kind": "timeout",
            },
        )
        == before + 1
    )


def test_closed_enumerations_drop_unbounded_values() -> None:
    assert bound_status("applied") == "ok"
    assert bound_status("not-a-status") == "other"
    assert bound_error_kind("timeout") == "timeout"
    assert bound_error_kind("stack-trace") == "exception"
    assert bound_dependency("maps") == "maps"
    assert bound_dependency("vendor-name") == "other"
    assert bound_realtime_event("audio") == "audio"
    assert bound_realtime_event("response.audio.delta") == "other"
    assert bound_db_operation("   ") == "OTHER"
    assert bound_stage("tts_first_audio_ms") == "tts_first_audio"
    assert bound_session_stage("waiting_user") == "waiting_user"
    assert bound_session_stage("leak-a-session-id") == "other"
    assert bound_end_reason("idle_timeout") == "idle_timeout"
    assert bound_end_reason("account-id") == "other"


def test_external_call_records_cancellation_without_exception_text() -> None:
    before = metric_value(
        "timeflow_external_requests_total",
        {
            "dependency": "tts",
            "operation": "session",
            "status": "cancelled",
            "error_kind": "cancelled",
        },
    )
    try:
        with ExternalCall("tts", "session"):
            raise asyncio.CancelledError
    except asyncio.CancelledError:
        pass

    assert (
        metric_value(
            "timeflow_external_requests_total",
            {
                "dependency": "tts",
                "operation": "session",
                "status": "cancelled",
                "error_kind": "cancelled",
            },
        )
        == before + 1
    )


@pytest.mark.asyncio
async def test_external_call_async_context_records_first_byte_once() -> None:
    before = metric_value(
        "timeflow_external_requests_total",
        {
            "dependency": "maps",
            "operation": "search",
            "status": "ok",
            "error_kind": "none",
        },
    )
    async with ExternalCall("maps", "search") as call:
        call.mark_first_byte()
        call.mark_first_byte()

    assert (
        metric_value(
            "timeflow_external_requests_total",
            {
                "dependency": "maps",
                "operation": "search",
                "status": "ok",
                "error_kind": "none",
            },
        )
        == before + 1
    )
