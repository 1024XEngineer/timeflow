"""Composed ASR, Agent, and TTS orchestration."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable
from uuid import uuid4

from timeflow.intelligence.conversation.agent import (
    Agent,
    AgentCompleted,
    AgentConversation,
    AgentEvent,
    AgentQuestion,
    AgentSessionEnd,
    AgentTextDelta,
    AgentToolRoundLimitError,
    AgentTurnContext,
)
from timeflow.intelligence.conversation.asr import (
    AsrPort,
    SpeechStarted,
    SpeechStopped,
    TranscriptCompleted,
    TranscriptPreview,
)
from timeflow.intelligence.conversation.schedule_tools import ScheduleResultObserver
from timeflow.intelligence.location import (
    ClientLocation,
    Coordinate,
    LocationInputError,
    LocationSearchService,
)
from timeflow.intelligence.ports import (
    AudioCanceled,
    AudioReply,
    DialogueQuestion,
    ReplyText,
    ResultSink,
    StreamInfo,
    Transcript,
)
from timeflow.intelligence.speech.pipeline import (
    SpeechAudioChunk,
    SpeechAudioCompleted,
    SpeechAudioStarted,
    SpeechPipeline,
)
from timeflow.intelligence.speech.tts import TtsPort
from timeflow.intelligence.telemetry import NOOP_TELEMETRY, TurnSpan, VoiceTelemetry

from .delivery import ScheduleResultDelivery
from .session import ComposedSession, ConversationState, TurnState

logger = logging.getLogger(__name__)

# Spoken instead of silence when one turn exhausts the tool-round budget (e.g. a batch
# delete that commits the first few schedules then hits the cap). The earlier tool calls
# have already committed, so the user must be told the rest were not processed.
_TOOL_ROUND_LIMIT_MESSAGE = "一次操作太多了，请拆成几次再试。"


def _client_location_from_stream(stream: AudioStreamInfo) -> ClientLocation | None:
    """Build a validated client position from the stream's raw wire fields, or None.

    None covers every reason location_search should degrade rather than the turn
    failing: no permission granted (all three fields unset), an unrecognized reference
    system, or coordinates the location module itself rejects as out of range.
    """
    if stream.latitude is None or stream.longitude is None or stream.coordinate_system is None:
        return None
    system = stream.coordinate_system.lower()
    if system not in ("wgs84", "gcj02"):
        return None
    try:
        return ClientLocation(Coordinate(stream.latitude, stream.longitude, system))  # type: ignore[arg-type]
    except LocationInputError:
        return None


@dataclass(slots=True)
class _TurnTiming:
    """Monotonic stage boundaries for one composed voice turn."""

    started_at: float
    input_completed_at: float | None = None
    asr_first_final_at: float | None = None
    asr_completed_at: float | None = None
    agent_first_output_at: float | None = None
    agent_completed_at: float | None = None
    llm_tool_call_ms: float | None = None
    tool_execution_ms: float | None = None
    llm_final_text_ms: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    speech_input_at: float | None = None
    tts_first_audio_at: float | None = None
    tts_completed_at: float | None = None
    audio_duration_ms: int | None = None

    @staticmethod
    def elapsed_ms(start: float | None, end: float | None) -> float | None:
        if start is None or end is None:
            return None
        return round((end - start) * 1000, 1)

    def fields(self, finished_at: float) -> dict[str, float | int | None]:
        return {
            "audio_duration_ms": self.audio_duration_ms,
            "audio_input_wall_ms": self.elapsed_ms(self.started_at, self.input_completed_at),
            "asr_total_ms": self.elapsed_ms(self.started_at, self.asr_completed_at),
            "asr_finalize_ms": self.elapsed_ms(self.input_completed_at, self.asr_completed_at),
            "asr_first_final_ms": self.elapsed_ms(self.started_at, self.asr_first_final_at),
            "llm_agent_first_output_ms": self.elapsed_ms(
                self.asr_completed_at,
                self.agent_first_output_at,
            ),
            "llm_agent_total_ms": self.elapsed_ms(
                self.asr_completed_at,
                self.agent_completed_at,
            ),
            "llm_tool_call_ms": self.llm_tool_call_ms,
            "tool_execution_ms": self.tool_execution_ms,
            "llm_final_text_ms": self.llm_final_text_ms,
            "tts_first_audio_ms": self.elapsed_ms(
                self.speech_input_at,
                self.tts_first_audio_at,
            ),
            "tts_total_ms": self.elapsed_ms(self.speech_input_at, self.tts_completed_at),
            "turn_total_ms": self.elapsed_ms(self.started_at, finished_at),
        }


@runtime_checkable
class _ClosableAsyncIterator(Protocol):
    async def aclose(self) -> None:
        """Close an asynchronous provider stream."""


class AudioStreamInfo(StreamInfo, Protocol):
    """Authenticated session and wire-format context for composed inbound audio."""

    @property
    def timezone(self) -> str: ...

    @property
    def audio_format(self) -> str: ...

    @property
    def sample_rate_hz(self) -> int: ...

    @property
    def channels(self) -> int: ...


class ConversationAgentFactory(Protocol):
    """Build one account-bound Agent for a retained conversation."""

    def __call__(
        self,
        account_id: str,
        observer: ScheduleResultObserver,
        client_location: ClientLocation | None,
    ) -> Agent:
        """Return an Agent whose tools are scoped to the authenticated account."""
        ...


class ComposedVoiceAgent:
    """Run provider-neutral ASR, conversational Agent, and TTS as one voice turn."""

    def __init__(
        self,
        asr: AsrPort,
        agent_factory: ConversationAgentFactory,
        tts: TtsPort,
        result_sink: ResultSink,
        *,
        location_service: LocationSearchService | None = None,
        clock: Callable[[], datetime] | None = None,
        monotonic: Callable[[], float] | None = None,
        reply_id_factory: Callable[[], str] | None = None,
        question_id_factory: Callable[[], str] | None = None,
        message_id_factory: Callable[[], str] | None = None,
        telemetry: VoiceTelemetry | None = None,
    ) -> None:
        self._asr = asr
        self._agent_factory = agent_factory
        self._tts = tts
        self._result_sink = result_sink
        self._location_service = location_service
        self._clock = clock or (lambda: datetime.now(UTC))
        self._monotonic = monotonic or time.monotonic
        self._reply_id_factory = reply_id_factory or (lambda: f"reply_{uuid4().hex}")
        self._question_id_factory = question_id_factory or (lambda: f"question_{uuid4().hex}")
        self._message_id_factory = message_id_factory or (lambda: f"msg_{uuid4().hex}")
        self._telemetry = telemetry if telemetry is not None else NOOP_TELEMETRY
        self._sessions: dict[str, ComposedSession] = {}
        self._sessions_lock = asyncio.Lock()

    async def handle_audio(
        self,
        chunks: AsyncIterator[bytes],
        stream: AudioStreamInfo,
    ) -> None:
        """Register and await one agent-owned composed turn."""
        session = await self._get_session(stream)
        async with session.turn_lock:
            async with session.lock:
                session.generation += 1
                generation = session.generation
                task = asyncio.create_task(self._run_turn(session, generation, chunks, stream))
                session.active_turn = TurnState(generation, task)
            try:
                await task
            except asyncio.CancelledError:
                caller = asyncio.current_task()
                if caller is not None and caller.cancelling():
                    raise
                if not task.cancelled():
                    raise
            finally:
                async with session.lock:
                    active = session.active_turn
                    if active is not None and active.generation == generation:
                        session.active_turn = None

    async def interrupt(self, session_id: str, reason: str) -> None:
        """Invalidate and cancel the active turn without clearing conversations."""
        del reason
        session = await self._find_session(session_id)
        if session is None:
            return
        async with session.lock:
            session.generation += 1
            turn = session.active_turn
            session.active_turn = None
            audio_id = session.active_audio_id
            audio_stream = session.active_audio_stream
            session.active_audio_id = None
            session.active_audio_stream = None
        if session.voice_mode == "continuous" and audio_id is not None and audio_stream is not None:
            await self._result_sink.deliver_canceled(AudioCanceled(audio_id), audio_stream)
        self._telemetry.set_session_stage(session_id, "waiting_user")
        await self._cancel(turn)

    async def close_session(self, session_id: str) -> None:
        """Invalidate all output, cancel the turn, and discard conversation memory."""
        session = await self._find_session(session_id)
        if session is None:
            return
        async with session.lock:
            session.generation += 1
            turn = session.active_turn
            session.active_turn = None
        await self._cancel(turn)
        async with self._sessions_lock:
            if self._sessions.get(session_id) is session:
                self._sessions.pop(session_id)
        async with session.lock:
            session.conversations.clear()

    async def _find_session(self, session_id: str) -> ComposedSession | None:
        """Return a retained session without holding the registry lock across other work."""
        async with self._sessions_lock:
            return self._sessions.get(session_id)

    async def _get_session(self, stream: AudioStreamInfo) -> ComposedSession:
        async with self._sessions_lock:
            session = self._sessions.get(stream.session_id)
            if session is None:
                session = ComposedSession(
                    stream.session_id,
                    stream.account_id,
                    stream.timezone,
                    stream.voice_mode,
                )
                self._sessions[stream.session_id] = session
                return session
            if session.account_id != stream.account_id:
                raise ValueError("A composed session cannot change authenticated account")
            if session.voice_mode != stream.voice_mode:
                raise ValueError("A composed session cannot change voice mode")
            session.timezone = stream.timezone
            return session

    async def _run_turn(
        self,
        session: ComposedSession,
        generation: int,
        chunks: AsyncIterator[bytes],
        stream: AudioStreamInfo,
    ) -> None:
        if stream.voice_mode == "continuous":
            await self._run_continuous(session, generation, chunks, stream)
            return
        timing = _TurnTiming(self._monotonic())
        turn_span = self._telemetry.start_turn(
            agent_mode="composed",
            voice_mode=stream.voice_mode,
            account_id=stream.account_id,
        )
        status = "failed"
        try:
            self._telemetry.set_session_stage(stream.session_id, "asr")
            transcript, audio_bytes = await self._transcribe(chunks, timing)
            timing.audio_duration_ms = self._duration_ms(stream, audio_bytes)
            status = await self._act_on_transcript(session, generation, transcript, stream, timing)
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception:
            logger.exception(
                "composed voice turn failed",
                extra={"session_id": stream.session_id, "stream_id": stream.stream_id},
            )
        finally:
            self._log_timing(stream, status, timing, turn_span)

    async def _run_continuous(
        self,
        session: ComposedSession,
        generation: int,
        chunks: AsyncIterator[bytes],
        stream: AudioStreamInfo,
    ) -> None:
        """Run one Agent turn per server-VAD final within a single long audio stream.

        A pump task consumes the ASR stream, forwarding finals to the main loop and
        flagging the start of new speech; when speech starts while a turn's TTS is
        playing, that turn is cancelled so the next final takes over immediately.
        """
        events = self._asr.stream(chunks)
        completed_queue: asyncio.Queue[
            tuple[TranscriptCompleted, float | None, float | None, float] | None
        ] = asyncio.Queue()
        barge_in = asyncio.Event()
        pump_error: Exception | None = None

        async def pump() -> None:
            nonlocal pump_error
            speech_started_at: float | None = None
            speech_stopped_at: float | None = None
            try:
                async for event in events:
                    if not await self._is_current(session, generation):
                        break
                    if isinstance(event, TranscriptCompleted):
                        # 埋点：定位「一次语音→多次回复」。服务端 VAD 可能把一句连续
                        # 语音切成多个 final，或对同一段音频重复回发 final——这里把每个
                        # final 的原文与时刻打出来，就能区分「同文本重复」还是「切分碎片」。
                        logger.info(
                            "composed asr final session_id=%s stream_id=%s text=%r",
                            stream.session_id,
                            stream.stream_id,
                            event.text,
                        )
                        await completed_queue.put(
                            (event, speech_started_at, speech_stopped_at, self._monotonic())
                        )
                        speech_started_at = None
                        speech_stopped_at = None
                    elif isinstance(event, SpeechStarted):
                        if speech_started_at is None:
                            speech_started_at = self._monotonic()
                        self._telemetry.set_session_stage(stream.session_id, "asr")
                        barge_in.set()
                    elif isinstance(event, SpeechStopped):
                        if speech_stopped_at is None:
                            speech_stopped_at = self._monotonic()
            except Exception as exc:
                pump_error = exc
            finally:
                await completed_queue.put(None)

        pump_task = asyncio.create_task(pump())

        try:
            while True:
                item = await completed_queue.get()
                if item is None:
                    break
                event, speech_started_at, speech_stopped_at, asr_completed_at = item
                text = event.text.strip()
                if not text:
                    self._telemetry.set_session_stage(stream.session_id, "waiting_user")
                    continue
                timing = _TurnTiming(
                    speech_started_at if speech_started_at is not None else asr_completed_at
                )
                # In continuous mode the input stream never ends, so the "utterance
                # finished" instant comes from the server-VAD speech_stopped event.
                # This makes asr_finalize_ms = speech_stopped → ASR final (the precise
                # "user finished speaking → transcript ready" latency).
                timing.input_completed_at = speech_stopped_at
                timing.asr_first_final_at = asr_completed_at
                timing.asr_completed_at = asr_completed_at
                barge_in.clear()
                turn_span = self._telemetry.start_turn(
                    agent_mode="composed",
                    voice_mode=stream.voice_mode,
                    account_id=stream.account_id,
                )
                turn_task = asyncio.create_task(
                    self._act_on_transcript(session, generation, text, stream, timing)
                )
                barge_task = asyncio.create_task(barge_in.wait())
                done, _ = await asyncio.wait(
                    {turn_task, barge_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )

                if turn_task in done:
                    barge_task.cancel()
                    await asyncio.gather(barge_task, return_exceptions=True)
                    status = await self._finish_continuous_turn(turn_task, stream)
                    self._log_timing(stream, status, timing, turn_span)
                else:
                    async with session.lock:
                        audio_id = session.active_audio_id
                        audio_stream = session.active_audio_stream
                    if audio_id is not None and audio_stream is not None:
                        await self._result_sink.deliver_canceled(
                            AudioCanceled(audio_id), audio_stream
                        )
                        turn_task.cancel()
                        await asyncio.gather(turn_task, return_exceptions=True)
                        self._log_timing(stream, "interrupted", timing, turn_span)
                    else:
                        barge_task.cancel()
                        await asyncio.gather(barge_task, return_exceptions=True)
                        status = await self._finish_continuous_turn(turn_task, stream)
                        self._log_timing(stream, status, timing, turn_span)
        finally:
            if not pump_task.done():
                pump_task.cancel()
                await asyncio.gather(pump_task, return_exceptions=True)
            if isinstance(events, _ClosableAsyncIterator):
                await events.aclose()

        if pump_error is not None:
            raise pump_error

    async def _finish_continuous_turn(
        self, turn_task: asyncio.Task[str], stream: AudioStreamInfo
    ) -> str:
        """Return a turn status without tearing down the still-open microphone stream.

        LLM or delivery failures on one utterance must not retire the audio sink:
        the client keeps sending PCM until voice.stream.end, and dropping the
        active stream surfaces as "Audio frames require voice.stream.start first".
        """
        try:
            return await turn_task
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "composed continuous turn failed",
                extra={"session_id": stream.session_id, "stream_id": stream.stream_id},
            )
            return "failed"

    async def _act_on_transcript(
        self,
        session: ComposedSession,
        generation: int,
        transcript: str,
        stream: AudioStreamInfo,
        timing: _TurnTiming,
    ) -> str:
        """Deliver one finalized utterance, run its Agent turn, and speak the result."""
        if not transcript.strip():
            self._telemetry.set_session_stage(stream.session_id, "waiting_user")
            return "empty_transcript"
        if not await self._is_current(session, generation):
            return "stale"
        self._telemetry.set_session_stage(stream.session_id, "asr")
        await self._result_sink.deliver_transcript(
            Transcript(transcript, "zh", timing.audio_duration_ms or 0),
            stream,
        )
        if not await self._is_current(session, generation):
            return "stale"
        self._telemetry.set_session_stage(stream.session_id, "llm")
        conversation = await self._conversation(
            session,
            generation,
            stream.conversation_id,
            stream,
        )
        events = conversation.agent.run_turn(
            conversation.conversation,
            transcript,
            turn_context=AgentTurnContext(
                self._clock(), session.timezone, session_id=stream.session_id
            ),
        )
        await self._deliver_agent_events(session, generation, events, stream, timing)
        return "completed"

    async def _transcribe(
        self,
        chunks: AsyncIterator[bytes],
        timing: _TurnTiming,
    ) -> tuple[str, int]:
        completed_parts: list[str] = []
        audio_bytes = 0

        async def counting_chunks() -> AsyncIterator[bytes]:
            nonlocal audio_bytes
            try:
                async for chunk in chunks:
                    audio_bytes += len(chunk)
                    yield chunk
            finally:
                timing.input_completed_at = self._monotonic()

        events = self._asr.stream(counting_chunks())
        try:
            async for event in events:
                if isinstance(event, (TranscriptPreview, SpeechStarted, SpeechStopped)):
                    continue
                if not isinstance(event, TranscriptCompleted):
                    raise ValueError("Unsupported ASR event")
                if timing.asr_first_final_at is None:
                    timing.asr_first_final_at = self._monotonic()
                # The ASR end is the last final transcript, not the stream teardown:
                # the adapter awaits websocket.close() only once this generator is
                # exhausted, so a timestamp taken after the loop would silently include
                # that close handshake on top of the recognition time.
                timing.asr_completed_at = self._monotonic()
                text = event.text.strip()
                if text:
                    completed_parts.append(text)
            return " ".join(completed_parts), audio_bytes
        finally:
            if isinstance(events, _ClosableAsyncIterator):
                await events.aclose()

    async def _conversation(
        self,
        session: ComposedSession,
        generation: int,
        conversation_id: str,
        stream: AudioStreamInfo,
    ) -> ConversationState:
        async with session.lock:
            state = session.conversations.get(conversation_id)
            if state is None:
                result_delivery = ScheduleResultDelivery(
                    self._result_sink,
                    message_id_factory=self._message_id_factory,
                )
                state = ConversationState(
                    AgentConversation(),
                    self._agent_factory(
                        session.account_id,
                        result_delivery,
                        _client_location_from_stream(stream),
                    ),
                    result_delivery,
                )
                session.conversations[conversation_id] = state
            state.result_delivery.bind(stream)
            return state

    async def _deliver_agent_events(
        self,
        session: ComposedSession,
        generation: int,
        events: AsyncIterator[AgentEvent],
        stream: AudioStreamInfo,
        timing: _TurnTiming,
    ) -> None:
        delivery_queue: asyncio.Queue[AgentEvent | None] = asyncio.Queue(maxsize=8)
        speech_queue: asyncio.Queue[AgentEvent | None] = asyncio.Queue(maxsize=8)

        session_ends = False

        async def produce() -> None:
            nonlocal session_ends
            try:
                async for event in events:
                    if timing.agent_first_output_at is None:
                        timing.agent_first_output_at = self._monotonic()
                    if not await self._is_current(session, generation):
                        return
                    if isinstance(event, AgentCompleted) and event.timing is not None:
                        timing.llm_tool_call_ms = event.timing.llm_tool_call_ms
                        timing.tool_execution_ms = event.timing.tool_execution_ms
                        timing.llm_final_text_ms = event.timing.llm_final_text_ms
                    if isinstance(event, AgentCompleted) and event.usage is not None:
                        timing.prompt_tokens = event.usage.prompt_tokens
                        timing.completion_tokens = event.usage.completion_tokens
                    if isinstance(event, AgentSessionEnd):
                        session_ends = True
                        continue
                    await asyncio.gather(delivery_queue.put(event), speech_queue.put(event))
            except AgentToolRoundLimitError:
                # 批量操作把单轮工具预算用尽时（比如逐条删除几十个日程，前几个已经
                # 提交），给用户一句语音提示，而不是让异常冒上去、只留日志一片沉默。
                if await self._is_current(session, generation):
                    fallback = AgentTextDelta(_TOOL_ROUND_LIMIT_MESSAGE)
                    await asyncio.gather(
                        delivery_queue.put(fallback),
                        speech_queue.put(fallback),
                    )
                    await asyncio.gather(
                        delivery_queue.put(AgentCompleted(None)),
                        speech_queue.put(AgentCompleted(None)),
                    )
            finally:
                timing.agent_completed_at = self._monotonic()
                await asyncio.gather(delivery_queue.put(None), speech_queue.put(None))

        producer = asyncio.create_task(produce())
        delivery = asyncio.create_task(
            self._deliver_text_events(
                session,
                generation,
                self._queue_events(delivery_queue),
                stream,
            )
        )
        speaking = asyncio.create_task(
            self._deliver_speech(
                session,
                generation,
                self._queue_events(speech_queue),
                timing,
                stream,
            )
        )
        tasks = {producer, delivery, speaking}
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            failure: BaseException | None = None
            for task in done:
                if task.cancelled():
                    continue
                if exception := task.exception():
                    failure = exception
                    break
            if failure is not None:
                raise failure
            await asyncio.gather(*tasks)
            if (
                session_ends
                and stream.voice_mode == "continuous"
                and await self._is_current(session, generation)
            ):
                await self._result_sink.deliver_session_end(stream)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _deliver_text_events(
        self,
        session: ComposedSession,
        generation: int,
        events: AsyncIterator[AgentEvent],
        stream: AudioStreamInfo,
    ) -> None:
        reply_id = self._reply_id_factory()
        text = ""
        async for event in events:
            if not await self._is_current(session, generation):
                return
            if isinstance(event, AgentTextDelta):
                text += event.text
                await self._result_sink.deliver_reply_text(
                    ReplyText(reply_id, text),
                    stream,
                )
            elif isinstance(event, AgentQuestion):
                await self._result_sink.deliver_question(
                    DialogueQuestion(
                        self._question_id_factory(),
                        event.question_kind,
                        event.speech_text,
                        event.required_response,
                        event.candidates,
                    ),
                    stream,
                )
            elif isinstance(event, AgentCompleted):
                await self._result_sink.deliver_reply_text(
                    ReplyText(reply_id, text, done=True),
                    stream,
                )

    @staticmethod
    async def _queue_events(
        queue: asyncio.Queue[AgentEvent | None],
    ) -> AsyncIterator[AgentEvent]:
        while True:
            item = await queue.get()
            try:
                if item is None:
                    return
                yield item
            finally:
                queue.task_done()

    async def _deliver_speech(
        self,
        session: ComposedSession,
        generation: int,
        events: AsyncIterator[AgentEvent],
        timing: _TurnTiming,
        stream: AudioStreamInfo,
    ) -> None:
        async def timed_events() -> AsyncIterator[AgentEvent]:
            async for event in events:
                if timing.speech_input_at is None and isinstance(
                    event,
                    (AgentTextDelta, AgentQuestion),
                ):
                    timing.speech_input_at = self._monotonic()
                yield event

        speech = SpeechPipeline(self._tts).stream(timed_events())
        queue: asyncio.Queue[bytes | None] | None = None
        delivery: asyncio.Task[None] | None = None
        try:
            async for event in speech:
                if not await self._is_current(session, generation):
                    return
                elif isinstance(event, SpeechAudioStarted):
                    if timing.tts_first_audio_at is None:
                        timing.tts_first_audio_at = self._monotonic()
                    queue = asyncio.Queue(maxsize=8)
                    reply = AudioReply(
                        event.audio_id,
                        event.audio_format,
                        event.sample_rate_hz,
                        event.purpose,
                        event.speech_text,
                    )
                    async with session.lock:
                        if session.generation != generation:
                            return
                        session.active_audio_id = event.audio_id
                        session.active_audio_stream = stream
                    delivery = asyncio.create_task(
                        self._result_sink.deliver_audio(reply, self._audio_chunks(queue), stream)
                    )
                elif isinstance(event, SpeechAudioChunk):
                    if queue is None:
                        raise ValueError("Speech audio chunk arrived before start")
                    if delivery is not None and delivery.done():
                        delivery.result()
                    await queue.put(event.data)
                elif isinstance(event, SpeechAudioCompleted):
                    if queue is None or delivery is None:
                        raise ValueError("Speech audio completed before start")
                    timing.tts_completed_at = self._monotonic()
                    await queue.put(None)
                    await delivery
                    async with session.lock:
                        if session.active_audio_id == event.audio_id:
                            session.active_audio_id = None
                            session.active_audio_stream = None
                    queue = None
                    delivery = None
        finally:
            if delivery is not None and not delivery.done():
                delivery.cancel()
            if delivery is not None:
                await asyncio.gather(delivery, return_exceptions=True)
            async with session.lock:
                if session.active_audio_stream is stream:
                    session.active_audio_id = None
                    session.active_audio_stream = None
            if isinstance(speech, _ClosableAsyncIterator):
                await speech.aclose()

    @staticmethod
    async def _audio_chunks(queue: asyncio.Queue[bytes | None]) -> AsyncIterator[bytes]:
        while True:
            chunk = await queue.get()
            try:
                if chunk is None:
                    return
                yield chunk
            finally:
                queue.task_done()

    def _log_timing(
        self,
        stream: AudioStreamInfo,
        status: str,
        timing: _TurnTiming,
        turn_span: TurnSpan | None = None,
    ) -> None:
        fields = timing.fields(self._monotonic())
        rendered = " ".join(
            f"{name}={value if value is not None else 'n/a'}" for name, value in fields.items()
        )
        logger.info(
            "composed voice turn timing status=%s session_id=%s stream_id=%s conversation_id=%s %s",
            status,
            stream.session_id,
            stream.stream_id,
            stream.conversation_id,
            rendered,
            extra={"timing_status": status, **fields},
        )
        if turn_span is None:
            return
        for name, value in fields.items():
            if isinstance(value, (int, float)):
                turn_span.record_stage(name, float(value))
        if timing.prompt_tokens is not None and timing.completion_tokens is not None:
            turn_span.record_llm_usage(
                prompt_tokens=timing.prompt_tokens,
                completion_tokens=timing.completion_tokens,
            )
        if (
            timing.llm_tool_call_ms is not None
            and timing.tool_execution_ms is not None
            and timing.llm_final_text_ms is not None
        ):
            self._telemetry.record_agent_timing(
                agent_mode="composed",
                llm_tool_call_ms=timing.llm_tool_call_ms,
                tool_execution_ms=timing.tool_execution_ms,
                llm_final_text_ms=timing.llm_final_text_ms,
            )
        turn_span.finish(status=status)

    @staticmethod
    async def _cancel(turn: TurnState | None) -> None:
        if turn is None or turn.task.done():
            return
        turn.task.cancel()
        await asyncio.gather(turn.task, return_exceptions=True)

    @staticmethod
    async def _is_current(session: ComposedSession, generation: int) -> bool:
        async with session.lock:
            return session.generation == generation

    @staticmethod
    def _duration_ms(stream: AudioStreamInfo, audio_bytes: int) -> int:
        bytes_per_sample = 2 if stream.audio_format == "pcm_s16le" else 1
        bytes_per_ms = stream.sample_rate_hz * stream.channels * bytes_per_sample / 1000
        return 0 if bytes_per_ms <= 0 else int(audio_bytes / bytes_per_ms)


__all__ = ["ComposedVoiceAgent", "ConversationAgentFactory"]
