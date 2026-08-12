"""Session reuse, budgets, and tool calls across turns of one conversation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from timeflow.intelligence.ports import (
    AudioReply,
    CommandResult,
    DialogueQuestion,
    ReplyText,
    Transcript,
)
from timeflow.intelligence.realtime.agent import (
    SESSION_MAX_AGE_SECONDS,
    SESSION_MAX_TURNS,
    RealtimeAgent,
)
from timeflow.intelligence.realtime.schedule_tools import ToolResult


@dataclass(frozen=True, slots=True)
class _Stream:
    """Identifiers of the audio stream a turn answers."""

    account_id: str = "acc_test"
    session_id: str = "ws_session_test"
    stream_id: str = "stream_test"
    conversation_id: str = "conversation_test"
    request_id: str | None = "req_voice_001"


@dataclass
class RecordingSink:
    """Record what the agent pushed, in order."""

    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def deliver_transcript(self, transcript: Transcript, stream: Any) -> None:
        self.calls.append(("transcript", transcript))

    async def deliver_reply_text(self, reply: ReplyText, stream: Any) -> None:
        self.calls.append(("done" if reply.done else "reply", reply.speech_text))

    async def deliver_result(self, result: CommandResult, stream: Any) -> None:
        self.calls.append(("result", result))

    async def deliver_question(self, question: DialogueQuestion, stream: Any) -> None:
        self.calls.append(("question", question))

    async def deliver_audio(
        self, reply: AudioReply, chunks: AsyncIterator[bytes], stream: Any
    ) -> None:
        self.calls.append(("audio_start", reply))
        async for chunk in chunks:
            self.calls.append(("audio", chunk))
        self.calls.append(("audio_end", reply.audio_id))

    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.calls]


class ScriptedSession:
    """A session that replays a scripted sequence of observer calls."""

    def __init__(self, script: list[tuple[str, Any]]) -> None:
        self._script = script
        self.audio_sent: list[bytes] = []
        self.finished = False
        self.closed = False
        self.tool_results: list[tuple[str, str]] = []

    async def send_audio(self, chunk: bytes) -> None:
        self.audio_sent.append(chunk)

    async def finish_input(self) -> None:
        self.finished = True

    async def send_tool_result(self, call_id: str, output: str) -> None:
        self.tool_results.append((call_id, output))

    async def close(self) -> None:
        self.closed = True

    async def pump(self, observer: Any) -> None:
        for kind, payload in self._script:
            await getattr(observer, kind)(*payload)


class CountingFactory:
    """Hand out a fresh scripted session per open, counting the opens."""

    def __init__(self, script: list[tuple[str, Any]] | None = None) -> None:
        self.script = script or []
        self.opened: list[ScriptedSession] = []

    async def open(self, instructions: str, tools: list[dict[str, Any]]) -> ScriptedSession:
        self.opened.append(ScriptedSession(list(self.script)))
        return self.opened[-1]


class StubToolBox:
    """Return a scripted result, recording what the model asked for."""

    def __init__(self, result: ToolResult) -> None:
        self.result = result
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def tools(self) -> list[dict[str, Any]]:
        return [{"type": "function", "function": {"name": "schedule_query"}}]

    async def run(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, arguments))
        return self.result


async def _chunks(*payloads: bytes) -> AsyncIterator[bytes]:
    for payload in payloads:
        yield payload


def test_a_second_turn_reuses_the_session_the_first_one_opened() -> None:
    """One conversation gets one session: a follow-up reaches a model that remembers."""

    async def scenario() -> None:
        factory = CountingFactory([("spoke", ("好",))])
        agent = RealtimeAgent(factory, RecordingSink())

        await agent.handle_audio(_chunks(b"a" * 3200), _Stream())
        await agent.handle_audio(_chunks(b"b" * 3200), _Stream())

        assert len(factory.opened) == 1
        assert factory.opened[0].closed is False

    asyncio.run(scenario())


def test_separate_conversations_do_not_share_a_session() -> None:
    """Two conversations are two sessions, so neither hears the other's turn."""

    async def scenario() -> None:
        factory = CountingFactory([("spoke", ("好",))])
        agent = RealtimeAgent(factory, RecordingSink())

        await agent.handle_audio(_chunks(b"a" * 3200), _Stream(conversation_id="conv_a"))
        await agent.handle_audio(_chunks(b"b" * 3200), _Stream(conversation_id="conv_b"))

        assert len(factory.opened) == 2

    asyncio.run(scenario())


def test_a_session_that_used_up_its_turns_is_replaced() -> None:
    """A session is swept once it has spent its turn budget, not left holding a connection."""

    async def scenario() -> None:
        factory = CountingFactory([("spoke", ("好",))])
        agent = RealtimeAgent(factory, RecordingSink())

        for _ in range(SESSION_MAX_TURNS):
            await agent.handle_audio(_chunks(b"a" * 3200), _Stream())
        assert len(factory.opened) == 1

        # The sweep runs at the start of the next turn, so the spent one closes then.
        await agent.handle_audio(_chunks(b"a" * 3200), _Stream())

        assert len(factory.opened) == 2
        assert factory.opened[0].closed is True

    asyncio.run(scenario())


def test_a_committed_tool_call_answers_the_client_and_the_model() -> None:
    """One call feeds both sides: the client gets the data, the model gets its result."""

    async def scenario() -> None:
        tools = StubToolBox(
            ToolResult(
                output=json.dumps({"status": "applied"}),
                outcome={"operation": "create_schedule", "status": "applied", "schedule": {}},
            )
        )
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "schedule_create", {"title": "开会"}))]
        )

        await RealtimeAgent(factory, sink, tools_factory=lambda _: tools).handle_audio(  # type: ignore[arg-type]
            _chunks(b"a" * 3200), _Stream()
        )

        assert tools.calls == [("schedule_create", {"title": "开会"})]
        (result,) = [payload for kind, payload in sink.calls if kind == "result"]
        assert result.operation == "create_schedule"
        assert result.status == "applied"
        assert result.schedule == {}
        assert result.schedules is None
        assert factory.opened[0].tool_results == [("call_1", json.dumps({"status": "applied"}))]

    asyncio.run(scenario())


def test_a_mutation_result_reaches_the_client_flat_not_wrapped_in_the_outcome() -> None:
    """The client reads payload.schedule.title, not payload.schedule.schedule.title."""

    async def scenario() -> None:
        snapshot = {"id": "sch_1", "title": "开会", "start_time": "2026-08-13T15:00:00+08:00"}
        tools = StubToolBox(
            ToolResult(
                output=json.dumps({"status": "applied"}),
                outcome={"operation": "create_schedule", "status": "applied", "schedule": snapshot},
            )
        )
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "schedule_create", {"title": "开会"}))]
        )

        await RealtimeAgent(factory, sink, tools_factory=lambda _: tools).handle_audio(  # type: ignore[arg-type]
            _chunks(b"a" * 3200), _Stream()
        )

        (result,) = [payload for kind, payload in sink.calls if kind == "result"]
        assert result.schedule == snapshot
        assert result.schedules is None

    asyncio.run(scenario())


def test_a_query_result_carries_the_matches_as_schedules_not_schedule() -> None:
    """A list_schedules outcome reaches the client as payload.schedules, per protocol §5.6."""

    async def scenario() -> None:
        matches = [{"id": "sch_1", "title": "开会"}, {"id": "sch_2", "title": "晨跑"}]
        tools = StubToolBox(
            ToolResult(
                output=json.dumps({"count": 2}),
                outcome={"operation": "list_schedules", "status": "applied", "schedules": matches},
            )
        )
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "schedule_query", {}))]
        )

        await RealtimeAgent(factory, sink, tools_factory=lambda _: tools).handle_audio(  # type: ignore[arg-type]
            _chunks(b"a" * 3200), _Stream()
        )

        (result,) = [payload for kind, payload in sink.calls if kind == "result"]
        assert result.operation == "list_schedules"
        assert result.schedules == matches
        assert result.schedule is None

    asyncio.run(scenario())


def test_a_refused_tool_call_reaches_the_model_and_not_the_client() -> None:
    """A refusal has no committed transaction to report, so the client is told nothing."""

    async def scenario() -> None:
        tools = StubToolBox(ToolResult(output=json.dumps({"status": "failed"})))
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "schedule_create", {"title": "开会"}))]
        )

        await RealtimeAgent(factory, sink, tools_factory=lambda _: tools).handle_audio(  # type: ignore[arg-type]
            _chunks(b"a" * 3200), _Stream()
        )

        assert "result" not in sink.kinds()
        assert factory.opened[0].tool_results == [("call_1", json.dumps({"status": "failed"}))]

    asyncio.run(scenario())


def test_a_question_from_a_tool_is_pushed_to_the_client() -> None:
    """A tool that needs more from the user turns into a question on the wire."""

    async def scenario() -> None:
        tools = StubToolBox(
            ToolResult(
                output=json.dumps({"asked": True}),
                question={
                    "question_kind": "missing_field",
                    "speech_text": "这个会是哪天的？",
                    "required_response": "start_time",
                    "candidates": (),
                },
            )
        )
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "request_user_input", {})), ("audio", (b"pcm",))]
        )

        await RealtimeAgent(factory, sink, tools_factory=lambda _: tools).handle_audio(  # type: ignore[arg-type]
            _chunks(b"a" * 3200), _Stream()
        )

        (question,) = [payload for kind, payload in sink.calls if kind == "question"]
        assert question.question_kind == "missing_field"
        assert question.speech_text == "这个会是哪天的？"
        assert question.required_response == "start_time"
        # The audio that follows is marked as asking, not as reporting a change.
        (reply,) = [payload for kind, payload in sink.calls if kind == "audio_start"]
        assert reply.purpose == "dialogue_question"

    asyncio.run(scenario())


def test_a_tool_call_with_no_tools_registered_is_ignored() -> None:
    """With no toolbox bound there is nothing to run, and the turn carries on."""

    async def scenario() -> None:
        sink = RecordingSink()
        factory = CountingFactory(
            [("tool_requested", ("call_1", "schedule_create", {})), ("spoke", ("好",))]
        )

        await RealtimeAgent(factory, sink).handle_audio(_chunks(b"a" * 3200), _Stream())

        assert factory.opened[0].tool_results == []
        assert "result" not in sink.kinds()
        assert "done" in sink.kinds()

    asyncio.run(scenario())


def test_a_session_that_grew_too_old_is_replaced() -> None:
    """Age retires a session even when it has turns left."""

    async def scenario() -> None:
        now = 0.0
        factory = CountingFactory([("spoke", ("好",))])
        agent = RealtimeAgent(factory, RecordingSink(), clock=lambda: now)

        await agent.handle_audio(_chunks(b"a" * 3200), _Stream())
        now = SESSION_MAX_AGE_SECONDS + 1
        await agent.handle_audio(_chunks(b"a" * 3200), _Stream())

        assert len(factory.opened) == 2
        assert factory.opened[0].closed is True

    asyncio.run(scenario())
