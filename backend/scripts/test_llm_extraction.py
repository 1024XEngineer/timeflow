#!/usr/bin/env python3
"""Smoke test for structured LLM schedule extraction."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import perf_counter
from zoneinfo import ZoneInfo

from timeflow.gateway.openai_llm import OpenAILLMClient
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.schedule_parser import (
    ScheduleDraftParseError,
    ScheduleDraftParser,
)

DEFAULT_TIMEZONE = "Asia/Shanghai"


@dataclass(frozen=True, slots=True)
class BoundaryCase:
    """One edge-case text and its expected outcome."""

    name: str
    text: str
    expect_success: bool


BOUNDARY_CASES: tuple[BoundaryCase, ...] = (
    BoundaryCase("empty_intent", "帮我安排一下", False),
    BoundaryCase("vague_time_only", "下周找个时间见客户", False),
    BoundaryCase("location_only", "去陆家嘴开会", True),
    BoundaryCase("precise_time", "明天下午三点开会", True),
    BoundaryCase("vague_time_and_location", "这个周末去医院复查，地点是浦东新区人民医院", True),
)


async def main() -> None:
    """Load local env config, call the LLM, and print parsed schedule data."""
    backend_root = Path(__file__).resolve().parents[1]
    settings = Settings.from_environment(backend_root / ".env")

    if not settings.openai.api_key:
        raise SystemExit("TIMEFLOW_OPENAI_API_KEY is empty in backend/.env")

    client = OpenAILLMClient(settings.openai)
    try:
        frozen_now = datetime.now(ZoneInfo(DEFAULT_TIMEZONE))
        parser = ScheduleDraftParser(client, current_time_provider=lambda: frozen_now)
        started_at = perf_counter()
        failed_cases = 0
        for index, case in enumerate(BOUNDARY_CASES, start=1):
            case_started_at = perf_counter()
            print(f"[{index}] {case.name}")
            print(case.text)
            try:
                result = await parser.parse(case.text)
            except ScheduleDraftParseError as exc:
                case_elapsed_seconds = perf_counter() - case_started_at
                print(f"Parse failed: {exc}")
                print(f"Elapsed: {case_elapsed_seconds:.3f}s")
                if case.expect_success:
                    failed_cases += 1
                    print("Result: unexpected failure")
                else:
                    print("Result: expected failure")
            else:
                case_elapsed_seconds = perf_counter() - case_started_at
                print(json.dumps(result.draft.to_payload(), ensure_ascii=False, indent=2))
                print("Raw model text:")
                print(result.raw_model_text)
                print(f"Elapsed: {case_elapsed_seconds:.3f}s")
                if case.expect_success:
                    print("Result: expected success")
                else:
                    failed_cases += 1
                    print("Result: unexpected success")
            print()

        total_elapsed_seconds = perf_counter() - started_at
        print(
            f"Summary: {len(BOUNDARY_CASES) - failed_cases}/{len(BOUNDARY_CASES)} matched expectation"
        )
        print(f"Total elapsed: {total_elapsed_seconds:.3f}s")
        if failed_cases:
            raise SystemExit(1)
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
