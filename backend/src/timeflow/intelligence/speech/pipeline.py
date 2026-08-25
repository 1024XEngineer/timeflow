"""Turn approved Agent events into ordered speech audio events."""

import asyncio
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass
from typing import Protocol, TypeAlias, cast, runtime_checkable
from uuid import uuid4

from timeflow.intelligence.conversation.agent import (
    AgentCompleted,
    AgentEvent,
    AgentQuestion,
    AgentTextDelta,
)
from timeflow.intelligence.speech.segmenter import TextSegmenter
from timeflow.intelligence.speech.tts import (
    SpeechPurpose,
    SpeechSegment,
    TtsAudioChunk,
    TtsCompleted,
    TtsPort,
)


@dataclass(frozen=True, slots=True)
class SpeechAudioStarted:
    """Metadata announced before one run of PCM audio chunks."""

    audio_id: str
    audio_format: str
    sample_rate_hz: int
    purpose: SpeechPurpose
    speech_text: str


@dataclass(frozen=True, slots=True)
class SpeechAudioChunk:
    """One audio block belonging to the active spoken reply."""

    audio_id: str
    data: bytes


@dataclass(frozen=True, slots=True)
class SpeechAudioCompleted:
    """The active spoken reply has no more audio blocks."""

    audio_id: str
    characters: int | None = None


SpeechPipelineEvent: TypeAlias = SpeechAudioStarted | SpeechAudioChunk | SpeechAudioCompleted


@runtime_checkable
class _ClosableAsyncIterator(Protocol):
    async def aclose(self) -> None:
        """Close the asynchronous stream and release its resources."""


class _EndOfSegments:
    """Sentinel marking that no more speech segments will arrive."""


_END_OF_SEGMENTS = _EndOfSegments()

# Suffixed once a turn's spoken text hits the total-character cap, so the user hears
# that the rest was dropped rather than the transcript silently ending mid-list.
_TRUNCATION_NOTICE = "，后面省略"


@dataclass(slots=True)
class _StreamMetadata:
    purpose: SpeechPurpose | None = None
    speech_text: str = ""


class SpeechPipeline:
    """Filter Agent events, segment approved text, and stream synthesized audio."""

    def __init__(
        self,
        tts: TtsPort,
        *,
        target_segment_length: int = 20,
        max_segment_length: int = 120,
        segment_queue_size: int = 8,
        max_total_characters: int = 100,
    ) -> None:
        if segment_queue_size <= 0:
            raise ValueError("segment_queue_size must be positive")
        if max_total_characters <= 0:
            raise ValueError("max_total_characters must be positive")
        self._tts = tts
        self._target_segment_length = target_segment_length
        self._max_segment_length = max_segment_length
        self._segment_queue_size = segment_queue_size
        self._max_total_characters = max_total_characters

    def stream(self, events: AsyncIterable[AgentEvent]) -> AsyncIterator[SpeechPipelineEvent]:
        """Process one Agent turn into a single ordered spoken reply."""
        return self._stream(events)

    async def _stream(
        self,
        events: AsyncIterable[AgentEvent],
    ) -> AsyncIterator[SpeechPipelineEvent]:
        queue: asyncio.Queue[SpeechSegment | _EndOfSegments] = asyncio.Queue(
            maxsize=self._segment_queue_size
        )
        # Fires as soon as the first non-empty text or question arrives, before the
        # segmenter has necessarily produced a complete segment. The TTS stream is
        # started on this signal so its WebSocket connect + handshake overlaps the
        # remaining segmentation instead of serialising after the first segment.
        speech_expected = asyncio.Event()
        metadata = _StreamMetadata()
        producer = asyncio.create_task(
            self._produce_segments(events, queue, speech_expected, metadata)
        )
        tts_stream: AsyncIterator[TtsAudioChunk | TtsCompleted] | None = None

        async def segment_stream() -> AsyncIterator[SpeechSegment]:
            while True:
                item = await queue.get()
                try:
                    if item is _END_OF_SEGMENTS:
                        self._raise_producer_failure(producer)
                        return
                    yield cast(SpeechSegment, item)
                finally:
                    queue.task_done()

        try:
            await self._wait_for_speech(speech_expected, producer)
            if metadata.purpose is None:
                await producer
                return

            audio_id = uuid4().hex
            tts_stream = self._tts.stream(segment_stream())
            started = False
            completed = False
            async for event in tts_stream:
                self._raise_producer_failure(producer)
                if isinstance(event, TtsAudioChunk):
                    if not started:
                        yield SpeechAudioStarted(
                            audio_id,
                            "pcm",
                            24000,
                            metadata.purpose,
                            metadata.speech_text,
                        )
                        started = True
                    yield SpeechAudioChunk(audio_id, event.data)
                elif isinstance(event, TtsCompleted):
                    if completed:
                        raise ValueError("TTS stream completed more than once")
                    completed = True
                    await producer
                    if not started:
                        yield SpeechAudioStarted(
                            audio_id,
                            "pcm",
                            24000,
                            metadata.purpose,
                            metadata.speech_text,
                        )
                    yield SpeechAudioCompleted(audio_id, event.characters)
                else:
                    raise ValueError("Unsupported TTS event for speech pipeline")
            await producer
            if not completed:
                raise ValueError("TTS stream ended without a completion event")
        finally:
            if not producer.done():
                producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            if tts_stream is not None and isinstance(tts_stream, _ClosableAsyncIterator):
                await tts_stream.aclose()

    async def _produce_segments(
        self,
        events: AsyncIterable[AgentEvent],
        queue: asyncio.Queue[SpeechSegment | _EndOfSegments],
        speech_expected: asyncio.Event,
        metadata: _StreamMetadata,
    ) -> None:
        segmenter = TextSegmenter(
            target_length=self._target_segment_length,
            max_length=self._max_segment_length,
        )
        next_index = 0
        submitted_characters = 0
        truncated = False

        def note_purpose(purpose: SpeechPurpose) -> None:
            """Record the turn's purpose and signal that speech is coming."""
            if metadata.purpose is None:
                metadata.purpose = purpose
                speech_expected.set()
            elif metadata.purpose != purpose:
                raise ValueError("One speech turn cannot mix question and reply text")

        async def submit(text: str, purpose: SpeechPurpose) -> None:
            nonlocal next_index, submitted_characters, truncated
            normalized = text.strip()
            if not normalized or truncated:
                return
            # 为「，后面省略」预留长度，保证一旦截断就一定能播报省略提示，而不是
            # 在累计恰好达到上限时把后续内容静默丢弃。
            remaining = (
                self._max_total_characters - len(_TRUNCATION_NOTICE) - submitted_characters
            )
            if len(normalized) <= remaining:
                await queue.put(SpeechSegment(next_index, normalized, purpose))
                next_index += 1
                submitted_characters += len(normalized)
                return
            head = normalized[:remaining] if remaining > 0 else ""
            await queue.put(SpeechSegment(next_index, head + _TRUNCATION_NOTICE, purpose))
            next_index += 1
            truncated = True

        cancelled = False
        try:
            async for event in events:
                if isinstance(event, AgentTextDelta):
                    if event.text.strip():
                        note_purpose("command_result")
                    for segment in segmenter.push(event.text):
                        await submit(segment, "command_result")
                elif isinstance(event, AgentQuestion):
                    if metadata.purpose is not None or segmenter.flush() is not None:
                        raise ValueError("One speech turn cannot mix question and reply text")
                    normalized = event.speech_text.strip()
                    if normalized:
                        note_purpose("dialogue_question")
                        metadata.speech_text = normalized
                        await submit(event.speech_text, "dialogue_question")
                    return
                elif isinstance(event, AgentCompleted):
                    if remainder := segmenter.flush():
                        await submit(remainder, "command_result")
                    return
                else:
                    raise ValueError("Unsupported Agent event for speech pipeline")

            if remainder := segmenter.flush():
                await submit(remainder, "command_result")
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if not cancelled:
                await queue.put(_END_OF_SEGMENTS)
                speech_expected.set()

    @staticmethod
    async def _wait_for_speech(
        speech_expected: asyncio.Event,
        producer: asyncio.Task[None],
    ) -> None:
        waiter = asyncio.create_task(speech_expected.wait())
        try:
            done, _ = await asyncio.wait(
                {waiter, producer},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if producer in done:
                producer.result()
            if waiter not in done:
                await waiter
        finally:
            if not waiter.done():
                waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)

    @staticmethod
    def _raise_producer_failure(producer: asyncio.Task[None]) -> None:
        if producer.done() and not producer.cancelled():
            exception = producer.exception()
            if exception is not None:
                raise exception


__all__ = [
    "SpeechAudioChunk",
    "SpeechAudioCompleted",
    "SpeechAudioStarted",
    "SpeechPipeline",
    "SpeechPipelineEvent",
]
