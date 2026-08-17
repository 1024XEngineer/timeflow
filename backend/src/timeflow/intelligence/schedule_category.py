"""Automatic schedule content classification using a narrow JSON LLM call."""

from __future__ import annotations

import json
import logging
from datetime import datetime

from timeflow.business.calendar.contracts import CreateScheduleCommand, ScheduleCategory
from timeflow.business.calendar.ports import ScheduleCategoryClassifier
from timeflow.intelligence.conversation.llm import ChatMessage, JsonLlmPort

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """Classify the schedule's content. Return JSON only in this exact shape:
{"category":"work"}
The category must be exactly one of: work, study, exercise, entertainment, social, rest,
personal, other. Use other when the schedule meaning is uncertain. Do not add other fields.
Examples: product review meeting=work; study Go=study; run five kilometers=exercise;
watch a movie=entertainment; dinner with friends=social; sleep=rest; haircut=personal."""


class LlmScheduleCategoryClassifier(ScheduleCategoryClassifier):
    """Classify a structured create command, degrading every failure to ``other``."""

    def __init__(self, llm: JsonLlmPort) -> None:
        self._llm = llm

    def classify(self, command: CreateScheduleCommand) -> ScheduleCategory:
        try:
            raw = self._llm.complete_json(
                (
                    ChatMessage(role="system", content=_SYSTEM_PROMPT),
                    ChatMessage(role="user", content=_classification_input(command)),
                )
            )
            payload = json.loads(raw)
            if not isinstance(payload, dict) or set(payload) != {"category"}:
                raise ValueError("classification response must contain only category")
            category = payload["category"]
            if not isinstance(category, str):
                raise ValueError("classification category must be a string")
            return ScheduleCategory(category)
        except Exception as exc:
            logger.warning(
                "schedule category classification failed; using other",
                extra={"error_type": type(exc).__name__},
            )
            return ScheduleCategory.OTHER


def _classification_input(command: CreateScheduleCommand) -> str:
    values: dict[str, object] = {
        "title": command.title,
        "schedule_type": command.schedule_type.value,
        "schedule_kind": command.schedule_kind.value,
        "is_all_day": command.is_all_day,
    }
    for field, value in (
        ("start_time", command.start_time),
        ("end_time", command.end_time),
        ("location_name", command.location_name),
        ("recurrence_rule", command.recurrence_rule),
    ):
        if value is not None:
            values[field] = value.isoformat() if isinstance(value, datetime) else value
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


__all__ = ["LlmScheduleCategoryClassifier"]
