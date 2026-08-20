"""Schedule category classification tests with a network-free JSON LLM fake."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest

from timeflow.business.calendar import (
    CreateScheduleCommand,
    ScheduleCategory,
    ScheduleKind,
    ScheduleType,
)
from timeflow.intelligence.conversation.llm import ChatMessage, LlmProviderError
from timeflow.intelligence.schedule_category import LlmScheduleCategoryClassifier


@dataclass
class _FakeJsonLlm:
    result: str | BaseException
    calls: int = 0
    messages: Sequence[ChatMessage] = ()

    def complete_json(self, messages: Sequence[ChatMessage]) -> str:
        self.calls += 1
        self.messages = messages
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def _command(title: str) -> CreateScheduleCommand:
    return CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title=title,
        timezone="Asia/Shanghai",
    )


@pytest.mark.parametrize(
    ("title", "category"),
    [
        ("明天下午三点和产品经理开需求评审会", ScheduleCategory.WORK),
        ("晚上学习 Go", ScheduleCategory.STUDY),
        ("晚上跑步五公里", ScheduleCategory.EXERCISE),
        ("今晚看电影", ScheduleCategory.ENTERTAINMENT),
        ("周六和朋友聚餐", ScheduleCategory.SOCIAL),
        ("晚上十一点睡觉", ScheduleCategory.REST),
        ("周末去剪头发", ScheduleCategory.PERSONAL),
        ("处理事情", ScheduleCategory.OTHER),
    ],
)
def test_classifier_accepts_every_supported_category(
    title: str,
    category: ScheduleCategory,
) -> None:
    llm = _FakeJsonLlm(f'{{"category":"{category.value}"}}')
    classifier = LlmScheduleCategoryClassifier(llm)

    assert classifier.classify(_command(title)) is category
    assert llm.calls == 1
    assert len(llm.messages) == 2
    assert title in llm.messages[1].content


@pytest.mark.parametrize(
    "result",
    [
        TimeoutError("timed out"),
        LlmProviderError("provider unavailable"),
        "not-json",
        '{"category":"unsupported"}',
        "",
    ],
    ids=["timeout", "provider-exception", "invalid-json", "unknown-enum", "empty"],
)
def test_classifier_returns_null_for_every_failure(
    result: str | BaseException,
) -> None:
    llm = _FakeJsonLlm(result)

    category = LlmScheduleCategoryClassifier(llm).classify(_command("任意日程"))

    assert category is None
    assert llm.calls == 1


def test_classifier_rejects_json_with_additional_fields() -> None:
    classifier = LlmScheduleCategoryClassifier(
        _FakeJsonLlm('{"category":"work","reason":"meeting"}')
    )

    assert classifier.classify(_command("开会")) is None


def test_classifier_rejects_a_non_string_category() -> None:
    classifier = LlmScheduleCategoryClassifier(_FakeJsonLlm('{"category":7}'))

    assert classifier.classify(_command("开会")) is None


def test_classifier_sends_only_structured_schedule_semantics() -> None:
    llm = _FakeJsonLlm('{"category":"social"}')
    command = CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.RECURRING,
        title="每周和朋友聚餐",
        timezone="Asia/Shanghai",
        start_time=datetime(2026, 8, 22, 10, tzinfo=UTC),
        end_time=datetime(2026, 8, 22, 12, tzinfo=UTC),
        recurrence_rule="FREQ=WEEKLY;BYDAY=SA",
        location_name="餐厅",
    )

    assert LlmScheduleCategoryClassifier(llm).classify(command) is ScheduleCategory.SOCIAL
    payload = llm.messages[1].content
    assert '"title":"每周和朋友聚餐"' in payload
    assert '"schedule_kind":"recurring"' in payload
    assert '"start_time":"2026-08-22T10:00:00+00:00"' in payload
    assert '"recurrence_rule":"FREQ=WEEKLY;BYDAY=SA"' in payload
