"""Intelligence telemetry seams stay provider-neutral."""

from timeflow.intelligence.telemetry import (
    NOOP_TELEMETRY,
    tool_metric_name,
    tool_result_status,
)


def test_unknown_tool_names_collapse_to_other() -> None:
    assert tool_metric_name("schedule_create") == "schedule_create"
    assert tool_metric_name("invented_tool") == "other"


def test_tool_result_status_reads_only_the_bounded_status_field() -> None:
    assert tool_result_status('{"status":"ok","result":{"title":"secret"}}') == "ok"
    assert tool_result_status('{"status":"applied"}') == "ok"
    assert tool_result_status('{"status":"failed","error":{"message":"no"}}') == "failed"
    assert tool_result_status('{"status":"provider_unavailable"}') == "provider_unavailable"
    assert tool_result_status("not-json") == "ok"
    assert tool_result_status("[1,2]") == "ok"
    assert tool_result_status('{"status":1}') == "ok"


def test_noop_telemetry_accepts_turn_and_tool_calls() -> None:
    span = NOOP_TELEMETRY.start_turn(
        agent_mode="composed",
        voice_mode="push_to_talk",
        account_id="acc_test",
    )
    span.record_stage("asr_total_ms", 12.0)
    span.record_llm_usage(prompt_tokens=1, completion_tokens=2)
    span.finish(status="completed")
    tool = NOOP_TELEMETRY.start_tool("schedule_query", agent_mode="composed")
    tool.finish(status="ok")
    NOOP_TELEMETRY.record_agent_timing(
        agent_mode="composed",
        llm_tool_call_ms=1.0,
        tool_execution_ms=2.0,
        llm_final_text_ms=3.0,
    )
    NOOP_TELEMETRY.set_session_stage("session_1", "asr")
    NOOP_TELEMETRY.record_interrupt("session_1")
