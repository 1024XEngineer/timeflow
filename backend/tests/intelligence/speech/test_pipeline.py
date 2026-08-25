"""Agent event to speech synthesis pipeline tests."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, AsyncIterator

import pytest

from timeflow.intelligence.conversation import (
    AgentCompleted,
    AgentQuestion,
    AgentTextDelta,
    LlmUsage,
)
from timeflow.intelligence.speech import (
    SpeechAudioChunk,
    SpeechAudioCompleted,
    SpeechAudioStarted,
    SpeechPipeline,
    SpeechSegment,
    TtsAudioChunk,
    TtsCompleted,
    TtsEvent,
)


class FakeTts:
    def __init__(
        self,
        events: list[TtsEvent] | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.events = events or [TtsAudioChunk(b"audio"), TtsCompleted()]
        self.error = error
        self.requests: list[tuple[SpeechSegment, ...]] = []

    def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
        return self._stream(segments)

    async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
        if self.error is not None:
            raise self.error
        self.requests.append(tuple([segment async for segment in segments]))
        for event in self.events:
            yield event


async def agent_events(*events: object) -> AsyncIterator[object]:
    for event in events:
        yield event


@pytest.mark.asyncio
async def test_first_sentence_audio_arrives_before_later_agent_events() -> None:
    release_second = asyncio.Event()
    first_segment_received = asyncio.Event()
    received: list[SpeechSegment] = []

    async def delayed_events() -> AsyncIterator[object]:
        yield AgentTextDelta("第一句。")
        await release_second.wait()
        yield AgentTextDelta("第二句。")
        yield AgentCompleted(None)

    class StreamingFakeTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            iterator = aiter(segments)
            first = await anext(iterator)
            received.append(first)
            first_segment_received.set()
            yield TtsAudioChunk(b"first-audio")
            received.append(await anext(iterator))
            with pytest.raises(StopAsyncIteration):
                await anext(iterator)
            yield TtsCompleted(8)

    pipeline = SpeechPipeline(StreamingFakeTts())
    stream = pipeline.stream(delayed_events())

    started = await asyncio.wait_for(anext(stream), timeout=1)
    chunk = await asyncio.wait_for(anext(stream), timeout=1)

    assert first_segment_received.is_set()
    assert release_second.is_set() is False
    assert isinstance(started, SpeechAudioStarted)
    assert started.purpose == "command_result"
    assert started.speech_text == ""
    assert chunk == SpeechAudioChunk(started.audio_id, b"first-audio")
    assert received == [SpeechSegment(0, "第一句。", "command_result")]

    release_second.set()
    assert await asyncio.wait_for(anext(stream), timeout=1) == SpeechAudioCompleted(
        started.audio_id, 8
    )
    assert received == [
        SpeechSegment(0, "第一句。", "command_result"),
        SpeechSegment(1, "第二句。", "command_result"),
    ]


@pytest.mark.asyncio
async def test_text_deltas_are_segmented_and_synthesized_as_one_turn() -> None:
    tts = FakeTts([TtsAudioChunk(b"one"), TtsAudioChunk(b"two"), TtsCompleted(24)])
    pipeline = SpeechPipeline(tts)

    output = [
        event
        async for event in pipeline.stream(
            agent_events(
                AgentTextDelta("已为你创建"),
                AgentTextDelta("明天下午三点的日程。"),
                AgentTextDelta("我会按时提醒你。"),
                AgentCompleted(LlmUsage(1, 2, 3)),
            )
        )
    ]

    assert len(output) == 4
    started = output[0]
    assert isinstance(started, SpeechAudioStarted)
    assert started.audio_format == "pcm"
    assert started.sample_rate_hz == 24000
    assert started.purpose == "command_result"
    assert started.speech_text == ""
    assert output[1:] == [
        SpeechAudioChunk(started.audio_id, b"one"),
        SpeechAudioChunk(started.audio_id, b"two"),
        SpeechAudioCompleted(started.audio_id, 24),
    ]
    assert tts.requests == [
        (
            SpeechSegment(0, "已为你创建明天下午三点的日程。", "command_result"),
            SpeechSegment(1, "我会按时提醒你。", "command_result"),
        )
    ]


@pytest.mark.asyncio
async def test_reply_is_truncated_at_total_character_cap() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts, max_total_characters=15)

    output = [
        event
        async for event in pipeline.stream(
            agent_events(
                AgentTextDelta("这是一段很长的回复文本内容用于测试截断功能"),
                AgentCompleted(LlmUsage(1, 2, 3)),
            )
        )
    ]

    segments = tts.requests[0]
    total = sum(len(segment.text) for segment in segments)
    assert total <= 15
    assert segments[-1].text.endswith("，后面省略")
    assert any(isinstance(event, SpeechAudioCompleted) for event in output)


@pytest.mark.asyncio
async def test_question_is_one_complete_dialogue_segment() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts)

    output = [
        event
        async for event in pipeline.stream(
            agent_events(
                AgentQuestion(
                    "missing_field",
                    "请问会议几点开始？",
                    "start_time",
                    (),
                )
            )
        )
    ]

    started = output[0]
    assert isinstance(started, SpeechAudioStarted)
    assert started.purpose == "dialogue_question"
    assert started.speech_text == "请问会议几点开始？"
    assert tts.requests == [(SpeechSegment(0, "请问会议几点开始？", "dialogue_question"),)]


@pytest.mark.asyncio
async def test_completed_flushes_remaining_text() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts)

    _ = [
        event
        async for event in pipeline.stream(
            agent_events(AgentTextDelta("没有结尾标点"), AgentCompleted(None))
        )
    ]

    assert tts.requests == [(SpeechSegment(0, "没有结尾标点", "command_result"),)]


@pytest.mark.asyncio
async def test_event_stream_end_flushes_remaining_text() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts)

    _ = [event async for event in pipeline.stream(agent_events(AgentTextDelta("剩余文本")))]

    assert tts.requests == [(SpeechSegment(0, "剩余文本", "command_result"),)]


@pytest.mark.asyncio
async def test_empty_turn_does_not_start_tts() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts)

    output = [event async for event in pipeline.stream(agent_events(AgentCompleted(None)))]

    assert output == []
    assert tts.requests == []


@pytest.mark.asyncio
async def test_tts_starts_before_first_segment_is_complete() -> None:
    tts_started = asyncio.Event()
    release_boundary = asyncio.Event()

    class PrewarmTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            tts_started.set()
            iterator = aiter(segments)
            _ = await anext(iterator)
            yield TtsAudioChunk(b"audio")
            with pytest.raises(StopAsyncIteration):
                await anext(iterator)
            yield TtsCompleted(2)

    async def events() -> AsyncIterator[object]:
        yield AgentTextDelta("第一句")  # no strong boundary yet, no segment
        await release_boundary.wait()
        yield AgentTextDelta("。")
        yield AgentCompleted(None)

    pipeline = SpeechPipeline(PrewarmTts())
    stream = pipeline.stream(events())

    output: list[object] = []

    async def consume() -> None:
        async for event in stream:
            output.append(event)

    task = asyncio.create_task(consume())
    # The TTS stream must have started (its connect would be in flight) while the
    # first sentence is still incomplete and no segment has been produced.
    await asyncio.wait_for(tts_started.wait(), timeout=1)
    assert release_boundary.is_set() is False

    release_boundary.set()
    await asyncio.wait_for(task, timeout=1)

    started = output[0]
    assert isinstance(started, SpeechAudioStarted)
    assert started.purpose == "command_result"
    assert started.speech_text == ""
    assert output[1:] == [
        SpeechAudioChunk(started.audio_id, b"audio"),
        SpeechAudioCompleted(started.audio_id, 2),
    ]


@pytest.mark.asyncio
async def test_mixed_question_and_reply_is_rejected() -> None:
    pipeline = SpeechPipeline(FakeTts())

    with pytest.raises(ValueError, match="cannot mix"):
        _ = [
            event
            async for event in pipeline.stream(
                agent_events(
                    AgentTextDelta("普通回答。"),
                    AgentQuestion("missing_field", "问题？", "field", ()),
                )
            )
        ]


@pytest.mark.asyncio
async def test_provider_failure_before_audio_does_not_emit_started() -> None:
    failure = RuntimeError("tts unavailable")
    pipeline = SpeechPipeline(FakeTts(error=failure))
    stream = pipeline.stream(agent_events(AgentTextDelta("回答。"), AgentCompleted(None)))

    with pytest.raises(RuntimeError, match="tts unavailable"):
        await anext(stream)


@pytest.mark.asyncio
async def test_producer_failure_during_tts_is_propagated() -> None:
    release_failure = asyncio.Event()

    async def failing_events() -> AsyncIterator[object]:
        yield AgentTextDelta("第一句。")
        await release_failure.wait()
        raise RuntimeError("agent stream failed")

    class WaitingTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            iterator = aiter(segments)
            _ = await anext(iterator)
            yield TtsAudioChunk(b"first")
            release_failure.set()
            await anext(iterator)
            yield TtsCompleted()  # pragma: no cover

    pipeline = SpeechPipeline(WaitingTts())
    stream = pipeline.stream(failing_events())
    _ = await anext(stream)
    _ = await anext(stream)

    with pytest.raises(RuntimeError, match="agent stream failed"):
        await anext(stream)


@pytest.mark.asyncio
async def test_tts_failure_cancels_agent_event_producer() -> None:
    producer_cancelled = asyncio.Event()

    async def open_events() -> AsyncIterator[object]:
        yield AgentTextDelta("第一句。")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            producer_cancelled.set()
            raise

    pipeline = SpeechPipeline(FakeTts(error=RuntimeError("tts failed")))

    with pytest.raises(RuntimeError, match="tts failed"):
        _ = [event async for event in pipeline.stream(open_events())]
    assert producer_cancelled.is_set()


@pytest.mark.asyncio
async def test_tts_failure_does_not_deadlock_when_segment_queue_is_full() -> None:
    async def many_events() -> AsyncIterator[object]:
        for index in range(100):
            yield AgentTextDelta(f"第{index}句。")

    class FailingTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            iterator = aiter(segments)
            _ = await anext(iterator)
            await asyncio.sleep(0)
            raise RuntimeError("tts failed")
            yield TtsCompleted()  # pragma: no cover

    pipeline = SpeechPipeline(FailingTts(), segment_queue_size=1)

    async def consume() -> None:
        _ = [event async for event in pipeline.stream(many_events())]

    with pytest.raises(RuntimeError, match="tts failed"):
        await asyncio.wait_for(consume(), timeout=1)


@pytest.mark.asyncio
async def test_cancellation_does_not_deadlock_when_segment_queue_is_full() -> None:
    tts_started = asyncio.Event()

    async def many_events() -> AsyncIterator[object]:
        for index in range(100):
            yield AgentTextDelta(f"第{index}句。")

    class BlockingTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            iterator = aiter(segments)
            _ = await anext(iterator)
            tts_started.set()
            await asyncio.Event().wait()
            yield TtsCompleted()  # pragma: no cover

    pipeline = SpeechPipeline(BlockingTts(), segment_queue_size=1)

    async def consume() -> None:
        _ = [event async for event in pipeline.stream(many_events())]

    task = asyncio.create_task(consume())
    await asyncio.wait_for(tts_started.wait(), timeout=1)
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)


@pytest.mark.asyncio
async def test_tts_stream_must_complete_exactly_once() -> None:
    missing = SpeechPipeline(FakeTts([TtsAudioChunk(b"audio")]))
    with pytest.raises(ValueError, match="without a completion"):
        _ = [
            event
            async for event in missing.stream(
                agent_events(AgentTextDelta("回答。"), AgentCompleted(None))
            )
        ]

    duplicate = SpeechPipeline(FakeTts([TtsCompleted(), TtsCompleted()]))
    with pytest.raises(ValueError, match="more than once"):
        _ = [
            event
            async for event in duplicate.stream(
                agent_events(AgentTextDelta("回答。"), AgentCompleted(None))
            )
        ]


@pytest.mark.asyncio
async def test_cancelling_pipeline_cancels_tts_stream() -> None:
    cancelled = asyncio.Event()
    tts_started = asyncio.Event()

    class BlockingTts:
        def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            return self._stream(segments)

        async def _stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
            iterator = aiter(segments)
            _ = await anext(iterator)
            tts_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            yield TtsCompleted()  # pragma: no cover

    pipeline = SpeechPipeline(BlockingTts())

    async def consume() -> None:
        _ = [
            event
            async for event in pipeline.stream(
                agent_events(AgentTextDelta("回答。"), AgentCompleted(None))
            )
        ]

    task = asyncio.create_task(consume())
    await asyncio.wait_for(tts_started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_blank_question_does_not_start_tts() -> None:
    tts = FakeTts()
    pipeline = SpeechPipeline(tts)

    output = [
        event
        async for event in pipeline.stream(
            agent_events(AgentQuestion("missing_field", "   ", "field", ()))
        )
    ]

    assert output == []
    assert tts.requests == []


@pytest.mark.asyncio
async def test_unsupported_agent_and_tts_events_are_rejected() -> None:
    pipeline = SpeechPipeline(FakeTts())
    with pytest.raises(ValueError, match="Unsupported Agent"):
        _ = [event async for event in pipeline.stream(agent_events(object()))]

    invalid_tts = FakeTts()
    invalid_tts.events = [object()]  # type: ignore[list-item]
    pipeline = SpeechPipeline(invalid_tts)
    with pytest.raises(ValueError, match="Unsupported TTS"):
        _ = [
            event
            async for event in pipeline.stream(
                agent_events(AgentTextDelta("回答。"), AgentCompleted(None))
            )
        ]


def test_invalid_queue_size_is_rejected() -> None:
    with pytest.raises(ValueError, match="positive"):
        SpeechPipeline(FakeTts(), segment_queue_size=0)
