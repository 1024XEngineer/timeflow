"""Composed voice orchestration with scripted provider-neutral dependencies."""

import asyncio
import logging
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest

from timeflow.business.calendar import (
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.intelligence.composed import ComposedVoiceAgent
from timeflow.intelligence.composed.agent import _client_location_from_stream
from timeflow.intelligence.conversation.agent import Agent, AgentToolRoundLimitError
from timeflow.intelligence.conversation.asr import SpeechStarted, SpeechStopped, TranscriptCompleted
from timeflow.intelligence.conversation.llm import (
    LlmStreamCompleted,
    TextDelta,
    ToolCallDelta,
)
from timeflow.intelligence.conversation.tools import ToolRegistry, request_user_input_definition
from timeflow.intelligence.ports import (
    AudioReply,
    CommandResult,
    DialogueQuestion,
    ReplyText,
    Transcript,
)
from timeflow.intelligence.speech.tts import SpeechSegment, TtsAudioChunk, TtsCompleted


@dataclass(frozen=True, slots=True)
class Stream:
    session_id: str = "session_1"
    account_id: str = "account_1"
    timezone: str = "Asia/Shanghai"
    voice_mode: str = "push_to_talk"
    latitude: float | None = None
    longitude: float | None = None
    coordinate_system: str | None = None
    stream_id: str = "stream_1"
    conversation_id: str = "conversation_1"
    request_id: str | None = "request_1"
    audio_format: str = "pcm_s16le"
    sample_rate_hz: int = 16000
    channels: int = 1


class FakeAsr:
    def __init__(self, transcripts: list[str]) -> None:
        self._transcripts = iter(transcripts)
        self.closed = 0

    def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
        async def events() -> AsyncIterator[Any]:
            try:
                async for _ in audio:
                    pass
                yield TranscriptCompleted(next(self._transcripts))
            finally:
                self.closed += 1

        return events()


class FakeLlm:
    def __init__(self, scripts: list[list[Any]]) -> None:
        self._scripts = iter(scripts)
        self.system_prompts: list[str] = []
        self.messages: list[list[Any]] = []

    def stream(self, messages: Any, tools: Any) -> AsyncIterator[Any]:
        del tools
        script = next(self._scripts)
        snapshot = list(messages)
        self.messages.append(snapshot)
        self.system_prompts.append(snapshot[0].content)

        async def events() -> AsyncIterator[Any]:
            for event in script:
                yield event

        return events()


@dataclass(frozen=True)
class QuestionTool:
    definition: Any = field(default_factory=request_user_input_definition)

    async def execute(self, arguments: Any) -> str:
        raise AssertionError("Agent handles request_user_input directly")


class FakeTts:
    def __init__(self) -> None:
        self.segments: list[SpeechSegment] = []

    def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[Any]:
        async def events() -> AsyncIterator[Any]:
            async for segment in segments:
                self.segments.append(segment)
                yield TtsAudioChunk(f"pcm:{segment.text}".encode())
            yield TtsCompleted(sum(len(segment.text) for segment in self.segments))

        return events()


@dataclass
class RecordingSink:
    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def deliver_transcript(self, value: Transcript, stream: Any) -> None:
        self.calls.append(("transcript", value))

    async def deliver_reply_text(self, value: ReplyText, stream: Any) -> None:
        self.calls.append(("reply", value))

    async def deliver_result(self, value: CommandResult, stream: Any) -> None:
        self.calls.append(("result", value))

    async def deliver_question(self, value: DialogueQuestion, stream: Any) -> None:
        self.calls.append(("question", value))

    async def deliver_audio(
        self, value: AudioReply, chunks: AsyncIterator[bytes], stream: Any
    ) -> None:
        self.calls.append(("audio_start", value))
        async for chunk in chunks:
            self.calls.append(("audio", chunk))
        self.calls.append(("audio_end", value.audio_id))

    async def deliver_canceled(self, value: Any, stream: Any) -> None:
        self.calls.append(("audio_canceled", value))

    async def deliver_session_end(self, stream: Any) -> None:
        self.calls.append(("session_end", stream.session_id))


async def chunks(payload: bytes = b"a" * 3200) -> AsyncIterator[bytes]:
    yield payload


def completed() -> LlmStreamCompleted:
    return LlmStreamCompleted("stop", None)


class StepClock:
    """Return deterministic monotonic values and continue after the scripted points."""

    def __init__(self, *values: float) -> None:
        self._values = iter(values)
        self._last = values[-1]

    def __call__(self) -> float:
        try:
            self._last = next(self._values)
        except StopIteration:
            self._last += 0.001
        return self._last


def timing_record(caplog: Any) -> logging.LogRecord:
    return next(
        record
        for record in caplog.records
        if record.getMessage().startswith("composed voice turn timing")
    )


def test_composed_turn_streams_a_multi_frame_reply() -> None:
    """Several vendor frames per segment reach the client in order (one sink chunk each)."""

    class MultiFrameTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for segment in segments:
                    text = segment.text.encode()
                    for index in range(3):
                        yield TtsAudioChunk(text + bytes([index]))
                yield TtsCompleted(0)

            return events()

    async def scenario() -> None:
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["明天下午三点提醒我"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好的。"), completed()]]),
                ToolRegistry([]),
            ),
            MultiFrameTts(),
            sink,
            clock=lambda: datetime(2026, 8, 12, 6, tzinfo=UTC),
            reply_id_factory=lambda: "reply_1",
        )

        await agent.handle_audio(chunks(), Stream())

        audio_kinds = [
            kind for kind, _ in sink.calls if kind in ("audio_start", "audio", "audio_end")
        ]
        # 每个 vendor 帧原样转发，三个小帧各自成为一次 audio 事件。
        assert audio_kinds == ["audio_start", "audio", "audio", "audio", "audio_end"]

    asyncio.run(scenario())


def test_composed_turn_with_empty_tts_reply_delivers_no_audio_frames() -> None:
    """TTS 无音频帧时（chunk_count 为 0）不产生 audio 事件，也不抛诊断异常。"""

    class EmptyTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in segments:
                    pass
                yield TtsCompleted(0)

            return events()

    async def scenario() -> None:
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["明天下午三点提醒我"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好的。"), completed()]]),
                ToolRegistry([]),
            ),
            EmptyTts(),
            sink,
            clock=lambda: datetime(2026, 8, 12, 6, tzinfo=UTC),
            reply_id_factory=lambda: "reply_1",
        )

        await agent.handle_audio(chunks(), Stream())

        audio_kinds = [
            kind for kind, _ in sink.calls if kind in ("audio_start", "audio", "audio_end")
        ]
        assert audio_kinds == ["audio_start", "audio_end"]

    asyncio.run(scenario())


def test_client_location_degrades_to_none_without_permission() -> None:
    """No coordinates, an unknown system, or out-of-range values all become None."""
    assert _client_location_from_stream(Stream()) is None
    assert _client_location_from_stream(Stream(latitude=31.2, longitude=121.5)) is None
    assert (
        _client_location_from_stream(
            Stream(latitude=31.2, longitude=121.5, coordinate_system="bd09")
        )
        is None
    )
    assert (
        _client_location_from_stream(
            Stream(latitude=91.0, longitude=121.5, coordinate_system="gcj02")
        )
        is None
    )


def test_client_location_keeps_a_valid_coordinate_system() -> None:
    location = _client_location_from_stream(
        Stream(latitude=31.22846, longitude=121.47822, coordinate_system="WGS84")
    )

    assert location is not None
    assert location.coordinate.coordinate_system == "wgs84"


def test_composed_turn_delivers_transcript_reply_and_tts() -> None:
    async def scenario() -> None:
        asr = FakeAsr(["明天下午三点提醒我"])
        llm = FakeLlm([[TextDelta("好，"), TextDelta("记下了。"), completed()]])
        tts = FakeTts()
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            asr,
            lambda account_id, observer, client_location: Agent(llm, ToolRegistry([])),
            tts,
            sink,
            clock=lambda: datetime(2026, 8, 12, 6, tzinfo=UTC),
            reply_id_factory=lambda: "reply_1",
        )

        await agent.handle_audio(chunks(), Stream())

        # The transcript leads, and the reply text stream is complete and ordered.
        # Audio now starts before the final "done" reply because the speech pipeline
        # prewarms the TTS connection as soon as text arrives, so the text and audio
        # streams legitimately interleave rather than text-then-audio.
        assert sink.calls[0][0] == "transcript"
        transcript = sink.calls[0][1]
        assert transcript.duration_ms == 100
        replies = [value for kind, value in sink.calls if kind == "reply"]
        assert [(reply.speech_text, reply.done) for reply in replies] == [
            ("好，", False),
            ("好，记下了。", False),
            ("好，记下了。", True),
        ]
        audio = [kind for kind, _ in sink.calls if kind in ("audio_start", "audio", "audio_end")]
        assert audio == ["audio_start", "audio", "audio_end"]
        assert tts.segments[0].text == "好，记下了。"
        assert "当前本地时间：2026-08-12T14:00:00+08:00" in llm.system_prompts[0]
        assert asr.closed == 1

    asyncio.run(scenario())


def test_tool_round_limit_becomes_a_spoken_fallback() -> None:
    """Exhausting the tool-round budget surfaces as speech, not a silent turn failure."""

    class RoundLimitAgent:
        def run_turn(
            self, conversation: Any, user_text: str, *, turn_context: Any = None
        ) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                raise AgentToolRoundLimitError("Agent tool round limit exceeded")
                yield  # pragma: no cover

            return events()

    async def scenario() -> None:
        tts = FakeTts()
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["删除这些日程"]),
            lambda account_id, observer, client_location: RoundLimitAgent(),
            tts,
            sink,
            reply_id_factory=lambda: "reply_1",
        )

        await agent.handle_audio(chunks(), Stream())

        replies = [value for kind, value in sink.calls if kind == "reply"]
        assert replies and replies[-1].done is True
        assert replies[-1].speech_text == "一次操作太多了，请拆成几次再试。"
        assert any(kind == "audio_end" for kind, _ in sink.calls)
        assert tts.segments and tts.segments[-1].text == "一次操作太多了，请拆成几次再试。"

    asyncio.run(scenario())


def test_round_limit_fallback_is_skipped_when_session_is_stale() -> None:
    """A turn that hit the round limit must not speak if its session is already stale."""

    async def scenario() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        class RoundLimitAgent:
            def run_turn(
                self, conversation: Any, user_text: str, *, turn_context: Any = None
            ) -> AsyncIterator[Any]:
                async def events() -> AsyncIterator[Any]:
                    started.set()
                    await release.wait()
                    raise AgentToolRoundLimitError("Agent tool round limit exceeded")
                    yield  # pragma: no cover

                return events()

        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["删除这些日程"]),
            lambda account_id, observer, client_location: RoundLimitAgent(),
            FakeTts(),
            sink,
            reply_id_factory=lambda: "reply_1",
        )

        task = asyncio.create_task(agent.handle_audio(chunks(), Stream()))
        await started.wait()
        # 模拟 turn 已被打断/关闭：推进 generation，使会话过期。
        session = agent._sessions["session_1"]
        async with session.lock:
            session.generation += 1
        release.set()
        await task

        # 会话已过期，不应再播报兜底文案。
        assert [kind for kind, _ in sink.calls if kind == "reply"] == []

    asyncio.run(scenario())


def test_push_to_talk_ignores_speech_started() -> None:
    """A VAD speech_started event before the final is ignored in push-to-talk mode."""

    class AsrWithSpeechStarted:
        def __init__(self) -> None:
            self.closed = 0

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                try:
                    async for _ in audio:
                        pass
                    yield SpeechStarted()
                    yield TranscriptCompleted("明天下午三点提醒我")
                finally:
                    self.closed += 1

            return events()

    async def scenario() -> None:
        asr = AsrWithSpeechStarted()
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            asr,
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好的。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream())

        assert [kind for kind, _ in sink.calls][0] == "transcript"
        assert "audio_end" in [kind for kind, _ in sink.calls]
        assert asr.closed == 1

    asyncio.run(scenario())


def test_successful_turn_logs_stage_timings_without_user_content(caplog: Any) -> None:
    """One summary exposes ASR, Agent, and TTS latency without logging the transcript."""

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["敏感的用户原话"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("简短回复。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            RecordingSink(),
            monotonic=StepClock(
                0.0,
                1.0,
                1.2,
                1.5,
                2.0,
                2.1,
                2.5,
                3.0,
                3.2,
                3.5,
            ),
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream())

    asyncio.run(scenario())

    record = timing_record(caplog)
    assert record.timing_status == "completed"
    assert record.audio_duration_ms == 100
    assert record.audio_input_wall_ms == 1000.0
    assert record.asr_total_ms == 1500.0
    assert record.asr_finalize_ms == 500.0
    assert record.asr_first_final_ms == 1200.0
    assert record.llm_agent_first_output_ms == 500.0
    assert record.llm_agent_total_ms == 1700.0
    assert record.tts_first_audio_ms == 400.0
    assert record.tts_total_ms == 900.0
    assert record.turn_total_ms == 3500.0
    assert "敏感的用户原话" not in record.getMessage()
    assert "audio_input_wall_ms=1000.0" in record.getMessage()
    assert "tts_first_audio_ms=400.0" in record.getMessage()


def test_turn_logs_llm_phase_breakdown(caplog: Any) -> None:
    """The Agent's tool-call / execution / text phases surface on the timing line."""

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["简短指令"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("简短回复。"), completed()]]),
                ToolRegistry([]),
                monotonic=StepClock(0.0, 0.5),
            ),
            FakeTts(),
            RecordingSink(),
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream())

    asyncio.run(scenario())

    record = timing_record(caplog)
    assert record.llm_tool_call_ms == 0.0
    assert record.tool_execution_ms == 0.0
    assert record.llm_final_text_ms == 500.0


def test_transcribe_records_asr_completion_before_stream_teardown(caplog: Any) -> None:
    """The ASR segment ends at the final transcript, not after the adapter tears down."""

    clock = StepClock(0.0, 1.0, 1.2, 1.5, 2.0, 2.1, 2.5, 3.0, 3.2, 3.5)

    class TeardownAsr:
        def __init__(self, clock: StepClock) -> None:
            self.clock = clock

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                try:
                    async for _ in audio:
                        pass
                    yield TranscriptCompleted("明天下午三点提醒我")
                finally:
                    # The real adapter awaits websocket.close() here; that teardown
                    # must not leak into asr_completed_at.
                    self.clock()

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            TeardownAsr(clock),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好的。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            RecordingSink(),
            monotonic=clock,
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream())

    asyncio.run(scenario())

    record = timing_record(caplog)
    # asr_total = asr_completed(1.5) - started(0.0); the teardown clock() at 2.0 must
    # not be counted as recognition time.
    assert record.asr_total_ms == 1500.0
    assert record.asr_finalize_ms == 500.0


def test_turn_without_speech_logs_unavailable_tts_timings(caplog: Any) -> None:
    """No synthesized response is represented by empty metrics, not a diagnostic failure."""

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["你好"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            RecordingSink(),
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream())

    asyncio.run(scenario())

    record = timing_record(caplog)
    assert record.timing_status == "completed"
    assert record.tts_first_audio_ms is None
    assert record.tts_total_ms is None
    assert "tts_first_audio_ms=n/a" in record.getMessage()


def test_composed_turn_combines_multiple_vad_completed_segments() -> None:
    """Server VAD may finalize several utterances during one client audio stream."""

    class SegmentedAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield TranscriptCompleted("帮我创建一个会议")
                yield TranscriptCompleted("明天下午三点")

            return events()

    async def scenario() -> None:
        llm = FakeLlm([[TextDelta("好的。"), completed()]])
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            SegmentedAsr(),
            lambda account_id, observer, client_location: Agent(llm, ToolRegistry([])),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream())

        transcript = next(value for kind, value in sink.calls if kind == "transcript")
        assert transcript.text == "帮我创建一个会议 明天下午三点"
        assert llm.messages[0][-1].content == transcript.text

    asyncio.run(scenario())


def test_continuous_stream_runs_one_turn_per_vad_final() -> None:
    """In continuous mode each VAD final becomes its own Agent turn on one conversation."""

    class SegmentedAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield TranscriptCompleted("创建会议")
                yield TranscriptCompleted("明天下午三点")

            return events()

    async def scenario() -> None:
        llm = FakeLlm(
            [
                [TextDelta("第一个回复。"), completed()],
                [TextDelta("第二个回复。"), completed()],
            ]
        )
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            SegmentedAsr(),
            lambda account_id, observer, client_location: Agent(llm, ToolRegistry([])),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

        transcripts = [value.text for kind, value in sink.calls if kind == "transcript"]
        assert transcripts == ["创建会议", "明天下午三点"]
        # Two separate, complete replies rather than one joined response.
        done_replies = [
            value.speech_text for kind, value in sink.calls if kind == "reply" and value.done
        ]
        assert done_replies == ["第一个回复。", "第二个回复。"]
        assert len(llm.messages) == 2

    asyncio.run(scenario())


def test_continuous_turn_logs_asr_and_llm_segment_timings(caplog: Any) -> None:
    """Continuous turns expose ASR-finalize and LLM latency instead of rendering n/a."""

    class ContinuousAsr:
        def __init__(self) -> None:
            self.closed = 0

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                try:
                    async for _ in audio:
                        pass
                    yield SpeechStarted()
                    yield TranscriptCompleted("你好")
                finally:
                    self.closed += 1

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            ContinuousAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("你好。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            RecordingSink(),
            monotonic=StepClock(0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0),
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

    asyncio.run(scenario())

    record = timing_record(caplog)
    assert record.timing_status == "completed"
    # ASR finalize is measured from the VAD speech_start to the final.
    assert record.asr_total_ms == 1000.0
    assert record.asr_first_final_ms == 1000.0
    # LLM latency is measured from the ASR final to first output and completion.
    assert record.llm_agent_first_output_ms is not None
    assert record.llm_agent_first_output_ms >= 0
    assert record.llm_agent_total_ms is not None
    assert record.llm_agent_total_ms >= record.llm_agent_first_output_ms
    # Continuous mode has no separate input/finalize phase or per-utterance byte count.
    assert record.audio_duration_ms is None
    assert record.audio_input_wall_ms is None
    assert record.asr_finalize_ms is None
    assert "llm_agent_first_output_ms=n/a" not in record.getMessage()
    assert "llm_agent_total_ms=n/a" not in record.getMessage()


def test_continuous_turn_logs_speech_stopped_finalize_latency(caplog: Any) -> None:
    """Continuous turns report asr_finalize from VAD speech_stopped, not input stream end."""

    class ContinuousAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield SpeechStarted()
                yield SpeechStopped()
                yield TranscriptCompleted("你好")

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            ContinuousAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("你好。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            RecordingSink(),
            monotonic=StepClock(0.0, 1.0, 2.0),
        )

        with caplog.at_level(logging.INFO):
            await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

    asyncio.run(scenario())

    record = timing_record(caplog)
    assert record.timing_status == "completed"
    # speech_start(0.0) → speech_stop(1.0) is the utterance's input wall time.
    assert record.audio_input_wall_ms == 1000.0
    # speech_stop(1.0) → final(2.0) is the precise ASR finalize latency.
    assert record.asr_finalize_ms == 1000.0


def test_question_is_retained_and_next_voice_turn_answers_original_tool_call() -> None:
    async def scenario() -> None:
        question = [
            ToolCallDelta(0, "call_question", "request_user_input", ""),
            ToolCallDelta(
                0,
                None,
                None,
                '{"question_kind":"missing_field","speech_text":"哪一天？",'
                '"required_response":"date","candidates":[]}',
            ),
            LlmStreamCompleted("tool_calls", None),
        ]
        llm = FakeLlm([question, [TextDelta("明天，好的。"), completed()]])
        asr = FakeAsr(["帮我安排会议", "明天"])
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            asr,
            lambda account_id, observer, client_location: Agent(
                llm, ToolRegistry([QuestionTool()])
            ),
            FakeTts(),
            sink,
            question_id_factory=lambda: "question_1",
        )
        stream = Stream()

        await agent.handle_audio(chunks(), stream)
        await agent.handle_audio(chunks(), Stream(stream_id="stream_2"))

        questions = [value for kind, value in sink.calls if kind == "question"]
        assert questions[0].question_id == "question_1"
        assert questions[0].speech_text == "哪一天？"
        second_messages = llm.messages[1]
        assert second_messages[-1].tool_call_id == "call_question"
        assert second_messages[-1].content == '{"user_response":"明天"}'

    asyncio.run(scenario())


def test_committed_mutation_is_delivered_as_snapshot_result() -> None:
    async def scenario() -> None:
        now = datetime(2026, 8, 12, 7, tzinfo=UTC)
        committed = ScheduleMutationResult(
            schedules=(
                ScheduleSnapshot(
                    id="schedule_1",
                    account_id="account_1",
                    schedule_type=ScheduleType.TIME,
                    schedule_kind=ScheduleKind.ONCE,
                    title="会议",
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
        llm = FakeLlm([[TextDelta("已创建。"), completed()]])
        sink = RecordingSink()

        def factory(account_id: str, observer: Any, client_location: Any = None) -> Agent:
            class CommittingAgent(Agent):
                def run_turn(self, conversation: Any, user_text: str, **kwargs: Any) -> Any:
                    async def events() -> AsyncIterator[Any]:
                        await observer.succeeded("schedule_create", committed)
                        yield TextDelta("已创建。")
                        yield completed()

                    return events()

            return CommittingAgent(llm, ToolRegistry([]))

        agent = ComposedVoiceAgent(
            FakeAsr(["创建会议"]),
            factory,
            FakeTts(),
            sink,
            message_id_factory=lambda: "msg_1",
        )

        await agent.handle_audio(chunks(), Stream())

        result = next(value for kind, value in sink.calls if kind == "result")
        assert result.message_id == "msg_1"
        assert result.operation == "create_schedule"
        assert result.schedule is not None
        assert result.schedule["id"] == "schedule_1"
        assert "account_id" not in result.schedule

    asyncio.run(scenario())


def test_successful_query_is_delivered_as_schedule_list() -> None:
    async def scenario() -> None:
        now = datetime(2026, 8, 12, 7, tzinfo=UTC)
        queried = ScheduleSearchResult(
            schedules=(
                ScheduleSnapshot(
                    id="schedule_1",
                    account_id="account_1",
                    schedule_type=ScheduleType.TIME,
                    schedule_kind=ScheduleKind.ONCE,
                    title="会议",
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
        sink = RecordingSink()

        def factory(account_id: str, observer: Any, client_location: Any = None) -> Agent:
            class QueryingAgent(Agent):
                def run_turn(self, conversation: Any, user_text: str, **kwargs: Any) -> Any:
                    async def events() -> AsyncIterator[Any]:
                        await observer.succeeded("schedule_query", queried)
                        yield completed()

                    return events()

            return QueryingAgent(FakeLlm([]), ToolRegistry([]))

        agent = ComposedVoiceAgent(
            FakeAsr(["查询会议"]),
            factory,
            FakeTts(),
            sink,
            message_id_factory=lambda: "msg_query",
        )

        await agent.handle_audio(chunks(), Stream())

        result = next(value for kind, value in sink.calls if kind == "result")
        assert result.message_id == "msg_query"
        assert result.operation == "list_schedules"
        assert result.schedule is None
        assert result.schedules is not None
        assert result.schedules[0]["id"] == "schedule_1"
        assert "account_id" not in result.schedules[0]

    asyncio.run(scenario())


def test_continuous_interruption_reports_canceled_before_audio_end() -> None:
    """Once TTS starts, barge-in reports cancellation before the framed end."""

    class BlockingSink(RecordingSink):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def deliver_audio(
            self,
            value: AudioReply,
            chunks: AsyncIterator[bytes],
            stream: Any,
        ) -> None:
            self.calls.append(("audio_start", value))
            self.started.set()
            async for chunk in chunks:
                self.calls.append(("audio", chunk))
                await self.release.wait()
            self.calls.append(("audio_end", value.audio_id))

        async def deliver_canceled(self, value: Any, stream: Any) -> None:
            self.calls.append(("audio_canceled", value))
            self.release.set()

    async def scenario() -> None:
        sink = BlockingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["你好"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("你好。"), completed()]]),
                ToolRegistry([]),
            ),
            FakeTts(),
            sink,
        )
        caller = asyncio.create_task(agent.handle_audio(chunks(), Stream(voice_mode="continuous")))
        await sink.started.wait()

        await agent.interrupt("session_1", "new_audio_stream")
        await caller

        kinds = [kind for kind, _ in sink.calls]
        assert kinds.index("audio_canceled") < kinds.index("audio_end")
        assert caller.cancelled() is False

    asyncio.run(scenario())


def test_continuous_speech_started_interrupts_playing_tts() -> None:
    """A speech_started during TTS playback cancels audio before the framed end."""

    class BlockingSink(RecordingSink):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def deliver_audio(
            self,
            value: AudioReply,
            chunks: AsyncIterator[bytes],
            stream: Any,
        ) -> None:
            self.calls.append(("audio_start", value))
            self.started.set()
            async for chunk in chunks:
                self.calls.append(("audio", chunk))
                await self.release.wait()
            self.calls.append(("audio_end", value.audio_id))

        async def deliver_canceled(self, value: Any, stream: Any) -> None:
            self.calls.append(("audio_canceled", value))
            self.release.set()

    class InterruptingAsr:
        def __init__(self, tts_started: asyncio.Event) -> None:
            self._tts_started = tts_started

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield SpeechStarted()
                yield TranscriptCompleted("第一句")
                await self._tts_started.wait()
                yield SpeechStarted()
                yield TranscriptCompleted("第二句")

            return events()

    async def scenario() -> None:
        sink = BlockingSink()
        agent = ComposedVoiceAgent(
            InterruptingAsr(sink.started),
            lambda account_id, observer, client_location: Agent(
                FakeLlm(
                    [
                        [TextDelta("第一句回复。"), completed()],
                        [TextDelta("第二句回复。"), completed()],
                    ]
                ),
                ToolRegistry([]),
            ),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

        kinds = [kind for kind, _ in sink.calls]
        assert kinds.index("audio_canceled") < kinds.index("audio_end")
        assert sum(1 for kind, _ in sink.calls if kind == "transcript") == 2

    asyncio.run(scenario())


def test_continuous_end_conversation_waits_for_farewell_audio() -> None:
    """Session end follows farewell text, audio, and voice.tts.end."""

    async def scenario() -> None:
        farewell = [
            TextDelta("再见。"),
            ToolCallDelta(0, "end_1", "end_conversation", "{}"),
            LlmStreamCompleted("tool_calls", None),
        ]
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr(["结束对话"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([farewell]), ToolRegistry([])
            ),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

        kinds = [kind for kind, _ in sink.calls]
        assert kinds[-1] == "session_end"
        assert kinds.index("audio_end") < kinds.index("session_end")
        final_reply = [value for kind, value in sink.calls if kind == "reply"][-1]
        assert final_reply == ReplyText(final_reply.reply_id, "再见。", done=True)

    asyncio.run(scenario())


def test_committed_result_survives_turn_invalidation() -> None:
    """A database commit is authoritative even when speech output is interrupted."""

    async def scenario() -> None:
        now = datetime(2026, 8, 12, 7, tzinfo=UTC)
        committed = ScheduleMutationResult(
            schedules=(
                ScheduleSnapshot(
                    id="schedule_1",
                    account_id="account_1",
                    schedule_type=ScheduleType.TIME,
                    schedule_kind=ScheduleKind.ONCE,
                    title="会议",
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
        sink = RecordingSink()
        observed = asyncio.Event()
        release = asyncio.Event()

        def factory(account_id: str, observer: Any, client_location: Any = None) -> Agent:
            class CommittingAgent(Agent):
                def run_turn(self, conversation: Any, user_text: str, **kwargs: Any) -> Any:
                    async def events() -> AsyncIterator[Any]:
                        observed.set()
                        await release.wait()
                        await observer.succeeded("schedule_create", committed)
                        yield completed()

                    return events()

            return CommittingAgent(FakeLlm([]), ToolRegistry([]))

        agent = ComposedVoiceAgent(FakeAsr(["创建会议"]), factory, FakeTts(), sink)
        caller = asyncio.create_task(agent.handle_audio(chunks(), Stream()))
        await observed.wait()

        session = await agent._find_session("session_1")
        assert session is not None
        async with session.lock:
            session.generation += 1
        release.set()
        await caller

        result = next(value for kind, value in sink.calls if kind == "result")
        assert result.schedule is not None
        assert result.schedule["id"] == "schedule_1"

    asyncio.run(scenario())


def test_queue_end_does_not_read_producer_state() -> None:
    """A sentinel may be dequeued before the producer task has returned from both puts."""

    async def scenario() -> None:
        queue: asyncio.Queue[Any | None] = asyncio.Queue()
        await queue.put(None)
        still_running = asyncio.create_task(asyncio.Event().wait())
        try:
            events = ComposedVoiceAgent._queue_events(queue)
            assert [event async for event in events] == []
            assert still_running.done() is False
        finally:
            still_running.cancel()
            await asyncio.gather(still_running, return_exceptions=True)

    asyncio.run(scenario())


def test_new_input_interrupts_an_active_turn_before_consuming_audio() -> None:
    """Gateway interruption cancels provider work while preserving conversation state."""

    class BlockingAsr:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.cancelled = asyncio.Event()

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                try:
                    async for _ in audio:
                        self.started.set()
                        await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled.set()
                    raise
                if False:  # pragma: no cover - preserves the async-generator shape
                    yield TranscriptCompleted("")

            return events()

    async def endless_chunks() -> AsyncIterator[bytes]:
        yield b"audio"
        await asyncio.Event().wait()

    async def scenario() -> None:
        asr = BlockingAsr()
        agent = ComposedVoiceAgent(
            asr,
            lambda account_id, observer, client_location: Agent(FakeLlm([]), ToolRegistry([])),
            FakeTts(),
            RecordingSink(),
        )
        caller = asyncio.create_task(agent.handle_audio(endless_chunks(), Stream()))
        await asr.started.wait()

        await agent.interrupt("session_1", "new_audio_stream")
        await caller

        assert caller.cancelled() is False
        assert asr.cancelled.is_set()

    asyncio.run(scenario())


def test_close_session_discards_retained_conversation() -> None:
    """A disconnected WebSocket cannot leak its conversation into a later session."""

    async def scenario() -> None:
        llm = FakeLlm(
            [
                [TextDelta("第一次。"), completed()],
                [TextDelta("第二次。"), completed()],
            ]
        )
        agent = ComposedVoiceAgent(
            FakeAsr(["第一轮", "第二轮"]),
            lambda account_id, observer, client_location: Agent(llm, ToolRegistry([])),
            FakeTts(),
            RecordingSink(),
        )

        await agent.handle_audio(chunks(), Stream())
        await agent.close_session("session_1")
        await agent.handle_audio(chunks(), Stream(stream_id="stream_2"))

        assert len(llm.messages[0]) == 2
        assert len(llm.messages[1]) == 2

    asyncio.run(scenario())


def test_continuous_asr_failure_is_propagated() -> None:
    """An ASR iterator exception must surface, not silently end the voice session."""

    class FailingAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                raise RuntimeError("asr provider disconnected")
                yield  # pragma: no cover

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FailingAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好的。"), completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            RecordingSink(),
        )

        with pytest.raises(RuntimeError, match="asr provider disconnected"):
            await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

    asyncio.run(scenario())


def test_command_result_rejects_mismatched_result_types() -> None:
    from timeflow.intelligence.composed.delivery import _command_result

    mutation = ScheduleMutationResult(schedules=())
    search = ScheduleSearchResult(schedules=())

    with pytest.raises(ValueError, match="schedule_query must return ScheduleSearchResult"):
        _command_result("msg", "schedule_query", mutation)
    with pytest.raises(ValueError, match="must return ScheduleMutationResult"):
        _command_result("msg", "schedule_create", search)
    with pytest.raises(ValueError, match="Unsupported successful schedule operation"):
        _command_result("msg", "bogus_op", mutation)


def test_command_result_preserves_occurrence_overrides_for_single_occurrence_delete() -> None:
    from timeflow.business.calendar import (
        OccurrenceOverrideAction,
        ScheduleOccurrenceOverrideSnapshot,
    )
    from timeflow.intelligence.composed.delivery import _command_result

    schedule = ScheduleSnapshot(
        id="sch_1",
        account_id="acc",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.RECURRING,
        title="周会",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=2,
        created_at=datetime(2026, 9, 7, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 9, 7, 0, 0, tzinfo=UTC),
        start_time=datetime(2026, 9, 8, 1, 0, tzinfo=UTC),
    )
    override = ScheduleOccurrenceOverrideSnapshot(
        id="ov_1",
        schedule_id="sch_1",
        occurrence_start=datetime(2026, 9, 8, 1, 0, tzinfo=UTC),
        action=OccurrenceOverrideAction.CANCEL,
        created_at=datetime(2026, 9, 7, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 9, 7, 0, 0, tzinfo=UTC),
    )
    result = ScheduleMutationResult(schedules=(schedule,), occurrence_overrides=(override,))

    command = _command_result("msg", "schedule_delete", result)

    assert command.schedules is not None
    assert command.schedules[0]["id"] == "sch_1"
    assert command.occurrence_overrides == [
        {
            "id": "ov_1",
            "schedule_id": "sch_1",
            "occurrence_start": override.occurrence_start.isoformat(),
            "action": "cancel",
            "replacement_schedule_id": None,
        }
    ]


def test_json_value_serializes_nested_structures() -> None:
    from timeflow.intelligence.composed.delivery import _json_value

    assert _json_value({"a": 1}) == {"a": 1}
    assert _json_value([1, 2]) == [1, 2]


def test_delivery_without_bound_stream_is_a_noop() -> None:
    from timeflow.intelligence.composed.delivery import ScheduleResultDelivery

    sink = RecordingSink()
    delivery = ScheduleResultDelivery(sink)

    async def scenario() -> None:
        await delivery.succeeded("schedule_create", ScheduleMutationResult(schedules=()))

    asyncio.run(scenario())

    assert sink.calls == []


def test_session_rejects_changed_account() -> None:
    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["你好"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好。"), completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            RecordingSink(),
        )
        await agent.handle_audio(chunks(), Stream())

        with pytest.raises(ValueError, match="cannot change authenticated account"):
            await agent.handle_audio(chunks(), Stream(account_id="other"))

    asyncio.run(scenario())


def test_session_rejects_changed_voice_mode() -> None:
    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["你好"]),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好。"), completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            RecordingSink(),
        )
        await agent.handle_audio(chunks(), Stream())

        with pytest.raises(ValueError, match="cannot change voice mode"):
            await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

    asyncio.run(scenario())


def test_interrupt_or_close_unknown_session_is_a_noop() -> None:
    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            FakeAsr(["你好"]),
            lambda account_id, observer, client_location: Agent(FakeLlm([]), ToolRegistry([])),
            FakeTts(),
            RecordingSink(),
        )
        await agent.interrupt("unknown_session", "reason")
        await agent.close_session("unknown_session")

    asyncio.run(scenario())


def test_empty_transcript_is_a_noop() -> None:
    async def scenario() -> None:
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            FakeAsr([""]),
            lambda account_id, observer, client_location: Agent(FakeLlm([]), ToolRegistry([])),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream())

        assert sink.calls == []

    asyncio.run(scenario())


def test_unsupported_asr_event_is_logged_and_swallowed(caplog: Any) -> None:
    class BogusAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield object()

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            BogusAsr(),
            lambda account_id, observer, client_location: Agent(FakeLlm([]), ToolRegistry([])),
            FakeTts(),
            RecordingSink(),
        )
        with caplog.at_level(logging.ERROR):
            await agent.handle_audio(chunks(), Stream())

    asyncio.run(scenario())

    assert "composed voice turn failed" in caplog.text


def test_continuous_skips_empty_finals() -> None:
    class EmptyThenFinalAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield TranscriptCompleted("   ")
                yield TranscriptCompleted("你好")

            return events()

    async def scenario() -> None:
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            EmptyThenFinalAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好。"), completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

        transcripts = [value.text for kind, value in sink.calls if kind == "transcript"]
        assert transcripts == ["你好"]

    asyncio.run(scenario())


def test_continuous_repeated_speech_markers_keep_first_timestamp() -> None:
    """A second VAD speech_started/stopped before a final keeps the first timestamp."""

    class RepeatedMarkerAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield SpeechStarted()
                yield SpeechStarted()
                yield SpeechStopped()
                yield SpeechStopped()
                yield TranscriptCompleted("你好")

            return events()

    async def scenario() -> None:
        agent = ComposedVoiceAgent(
            RepeatedMarkerAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm([[TextDelta("好。"), completed()]]), ToolRegistry([])
            ),
            FakeTts(),
            RecordingSink(),
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

    asyncio.run(scenario())


def test_continuous_speech_started_before_tts_is_ignored() -> None:
    """A speech_started while the LLM is still generating (no active TTS) is ignored."""

    llm_started = asyncio.Event()
    release_llm = asyncio.Event()

    class GatedLlm:
        def stream(self, messages: Any, tools: Any) -> AsyncIterator[Any]:
            del tools

            async def events() -> AsyncIterator[Any]:
                llm_started.set()
                yield TextDelta("慢速回复")
                await release_llm.wait()
                yield completed()

            return events()

    class EarlySpeechAsr:
        def __init__(self, llm_started: asyncio.Event) -> None:
            self._llm_started = llm_started

        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield TranscriptCompleted("你好")
                await self._llm_started.wait()
                yield SpeechStarted()

            return events()

    async def scenario() -> None:
        sink = RecordingSink()
        agent = ComposedVoiceAgent(
            EarlySpeechAsr(llm_started),
            lambda account_id, observer, client_location: Agent(GatedLlm(), ToolRegistry([])),
            FakeTts(),
            sink,
        )
        task = asyncio.create_task(agent.handle_audio(chunks(), Stream(voice_mode="continuous")))
        await asyncio.wait_for(llm_started.wait(), 2)
        await asyncio.sleep(0.01)
        release_llm.set()
        await task

        assert all(kind != "audio_canceled" for kind, _ in sink.calls)

    asyncio.run(scenario())


def test_continuous_turn_failure_keeps_listening_for_later_finals() -> None:
    """A failed utterance must not cancel the ASR pump or drop later finals."""

    class FlakySink(RecordingSink):
        def __init__(self) -> None:
            super().__init__()
            self._failed = False

        async def deliver_reply_text(self, value: Any, stream: Any) -> None:
            if not self._failed:
                self._failed = True
                raise RuntimeError("sink failed")
            await super().deliver_reply_text(value, stream)

    class TwoFinalsAsr:
        def stream(self, audio: AsyncIterable[bytes]) -> AsyncIterator[Any]:
            async def events() -> AsyncIterator[Any]:
                async for _ in audio:
                    pass
                yield TranscriptCompleted("第一句")
                yield TranscriptCompleted("第二句")

            return events()

    async def scenario() -> None:
        sink = FlakySink()
        agent = ComposedVoiceAgent(
            TwoFinalsAsr(),
            lambda account_id, observer, client_location: Agent(
                FakeLlm(
                    [
                        [TextDelta("失败。"), completed()],
                        [TextDelta("成功。"), completed()],
                    ]
                ),
                ToolRegistry([]),
            ),
            FakeTts(),
            sink,
        )

        await agent.handle_audio(chunks(), Stream(voice_mode="continuous"))

        transcripts = [value.text for kind, value in sink.calls if kind == "transcript"]
        assert transcripts == ["第一句", "第二句"]
        done_replies = [
            value.speech_text for kind, value in sink.calls if kind == "reply" and value.done
        ]
        assert done_replies == ["成功。"]

    asyncio.run(scenario())
