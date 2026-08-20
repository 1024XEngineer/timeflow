"""Agent that hands turns to a realtime speech model and reports what it says."""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from timeflow.intelligence.location import ClientLocation, Coordinate, LocationInputError
from timeflow.intelligence.ports import (
    AudioCanceled,
    AudioReply,
    CommandResult,
    DialogueQuestion,
    ReplyText,
    ResultSink,
    StreamInfo,
)
from timeflow.intelligence.ports import Transcript as HeardSpeech
from timeflow.intelligence.realtime.ports import RealtimeSession, RealtimeSessionFactory
from timeflow.intelligence.realtime.schedule_tools import ToolBox

logger = logging.getLogger(__name__)

# The model emits 24 kHz mono PCM; the client is told so in voice.tts.start.
REPLY_SAMPLE_RATE_HZ = 24_000
REPLY_AUDIO_FORMAT = "pcm"

# An answer and a question sound alike on the wire, so the client is told which it is
# getting -- it may want to keep a microphone open for one of them.
REPLY_PURPOSE = "command_result"
QUESTION_PURPOSE = "dialogue_question"

# Language is reported as the model's own, not detected here.
ASSUMED_LANGUAGE = "zh"

# 16 kHz mono 16-bit: 32 bytes per millisecond.
_INPUT_BYTES_PER_MS = 32

# The vendor caps one session at 50 turns or 300 seconds and drops it on the spot. Both
# budgets are treated as smaller than they are, so a session is replaced while it still
# works rather than after a turn has already been lost to it.
SESSION_MAX_TURNS = 40
SESSION_MAX_AGE_SECONDS = 240.0


def new_audio_id() -> str:
    """Return a fresh identifier for one spoken reply."""
    return f"audio_{uuid4().hex}"


def new_reply_id() -> str:
    """Return a fresh identifier tying one reply's wording updates together."""
    return f"reply_{uuid4().hex}"


def new_message_id() -> str:
    """Return a fresh identifier for a result the client must acknowledge."""
    return f"msg_{uuid4().hex}"


def new_question_id() -> str:
    """Return a fresh identifier for one question put to the user."""
    return f"question_{uuid4().hex}"


def _client_location_from_stream(stream: StreamInfo) -> ClientLocation | None:
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
class _Held:
    """A session kept open past its turn, so the next turn remembers this one."""

    session: RealtimeSession
    tools: ToolBox | None
    opened_at: float
    voice_mode: str
    turns: int = 0


class RealtimeAgent:
    """Feed audio streams to a realtime model, one conversation at a time."""

    def __init__(
        self,
        sessions: RealtimeSessionFactory,
        result_sink: ResultSink,
        *,
        tools_factory: Callable[[str, str, ClientLocation | None], Awaitable[ToolBox]]
        | None = None,
        instructions: Callable[[str], str] | None = None,
        audio_id_factory: Callable[[], str] | None = None,
        reply_id_factory: Callable[[], str] | None = None,
        message_id_factory: Callable[[], str] | None = None,
        question_id_factory: Callable[[], str] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        """Store the session source, the sink, the tools, and the id and clock seams."""
        self._sessions = sessions
        self._result_sink = result_sink
        self._tools_factory = tools_factory
        # Called per session, so a long-running server keeps saying what day it is now.
        self._instructions = instructions or (lambda _timezone: "")
        self._audio_id_factory = audio_id_factory or new_audio_id
        self._reply_id_factory = reply_id_factory or new_reply_id
        self._message_id_factory = message_id_factory or new_message_id
        self._question_id_factory = question_id_factory or new_question_id
        # Monotonic, not wall clock: a live session must not be thrown away for being
        # hours old because the host's clock was corrected.
        self._clock = clock or time.monotonic
        self._held: dict[tuple[str, str], _Held] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Run the conversation's session for this stream, keeping it for the next one.

        Push-to-talk: one stream is one reply, and this returns once the reply is done.
        Continuous mode: one stream may carry many replies, each bounded by the vendor's
        own turn detection; this returns once the client closes its microphone.
        """
        key = (stream.account_id, stream.conversation_id)
        await self._close_spent()
        self._forget_idle_locks()

        async with self._lock_for(key):
            held = await self._session_for(key, stream)
            if held is None:
                return

            turn = _Turn(
                self._result_sink,
                stream,
                session=held.session,
                tools=held.tools,
                audio_id_factory=self._audio_id_factory,
                reply_id_factory=self._reply_id_factory,
                message_id_factory=self._message_id_factory,
                question_id_factory=self._question_id_factory,
            )
            # Feeding starts before listening, matching the real causal order: the model
            # cannot transcribe audio it has not been sent, so a transcript's reported
            # duration is counted against the audio that actually produced it. Nothing is
            # missed by reading a moment later -- frames that arrive first are buffered.
            forwarding = asyncio.create_task(self._forward_audio(chunks, held.session, turn))
            pumping = asyncio.create_task(held.session.pump(turn))
            reusable = False
            try:
                # Both sides are watched, because either can end the turn. In continuous
                # mode the microphone stays open until the user hangs up, so a pump that
                # exited early -- a vendor error ends it -- would otherwise go unnoticed
                # and leave this waiting on a client that is itself waiting to be told the
                # session is over.
                await asyncio.wait({forwarding, pumping}, return_when=asyncio.FIRST_COMPLETED)
                if forwarding.done():
                    # Re-raised rather than swallowed: a broken input stream is the
                    # caller's to hear about.
                    await forwarding
                    if held.voice_mode == "push_to_talk":
                        await pumping
                    elif not pumping.done():
                        # The vendor decides when each reply starts and ends, so pump()
                        # never returns on its own; once the microphone closes there is
                        # nothing further for it to report. Telling the vendor to stop
                        # first matters: cancelling the pump alone stops us from reading
                        # while it keeps generating into the same socket, and since this
                        # session gets reused those frames would bleed into the next turn.
                        await held.session.cancel_response()
                reusable = turn.failure is None
            finally:
                # Cancelled on every exit, not just the caller's: an orphaned pump sits in
                # recv(), and an orphaned forwarder sits on the client's stream.
                forwarding.cancel()
                pumping.cancel()
                for task in (forwarding, pumping):
                    with contextlib.suppress(BaseException):
                        await task
                await turn.close()
                # Kept only after a turn it survived. A failure, an exception, or a client
                # that hung up mid-turn leaves state nobody has reasoned about, and
                # reusing it carries that into the next turn.
                if reusable:
                    held.turns += 1
                else:
                    await self._discard(key)

    async def _forward_audio(
        self, chunks: AsyncIterator[bytes], session: RealtimeSession, turn: "_Turn"
    ) -> None:
        """Feed the client's audio to the model until the stream ends."""
        async for chunk in chunks:
            await session.send_audio(chunk)
            turn.note_input_chunk(len(chunk))
        await session.finish_input()

    async def _session_for(self, key: tuple[str, str], stream: StreamInfo) -> _Held | None:
        """Return the conversation's open session, opening one when there is none.

        The timezone and location only matter for a session opened fresh here -- a held
        session keeps whatever zone and location were live when it opened. A conversation
        crossing zones or moving mid-flight is not handled; it is replaced the ordinary way
        once its budget runs out. A voice mode change is handled at once instead: the vendor
        only accepts turn_detection at connect time, so a held session in the wrong mode is
        discarded and reopened.
        """
        held = self._held.get(key)
        if held is not None:
            if held.voice_mode == stream.voice_mode:
                return held
            await self._discard(key)

        account_id, _ = key
        timezone = stream.timezone
        voice_mode = stream.voice_mode
        tools = (
            await self._tools_factory(account_id, timezone, _client_location_from_stream(stream))
            if self._tools_factory is not None
            else None
        )
        schemas = tools.tools() if tools is not None else []
        try:
            session = await self._sessions.open(self._instructions(timezone), schemas, voice_mode)
        except Exception:
            logger.exception("could not open a realtime session")
            return None
        fresh = _Held(session=session, tools=tools, opened_at=self._clock(), voice_mode=voice_mode)
        self._held[key] = fresh
        return fresh

    async def _close_spent(self) -> None:
        """Close sessions that used up a budget, whether or not they get used again.

        Swept here rather than on the conversation's next turn because a conversation may
        have no next turn, and the session would hold a vendor connection until exit.
        """
        spent = [
            key
            for key, held in self._held.items()
            if self._spent(held) and not self._lock_for(key).locked()
        ]
        for key in spent:
            logger.info(
                "replacing a realtime session that ran out of budget",
                extra={"account_id": key[0], "conversation_id": key[1]},
            )
            await self._discard(key)

    def _spent(self, held: _Held) -> bool:
        """Report whether a session has used up either of its budgets."""
        if held.turns >= SESSION_MAX_TURNS:
            return True
        return self._clock() - held.opened_at >= SESSION_MAX_AGE_SECONDS

    async def _discard(self, key: tuple[str, str]) -> None:
        """Forget a conversation's session and close it."""
        held = self._held.pop(key, None)
        if held is not None:
            await held.session.close()

    def _lock_for(self, key: tuple[str, str]) -> asyncio.Lock:
        """Return the lock that serializes turns within one conversation.

        A session is a sequence of append, commit, respond; two turns interleaving on one
        would fold one burst of audio into the other's answer. Nothing is awaited between
        the lookup and the acquire, so two turns cannot each create their own lock.
        """
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _forget_idle_locks(self) -> None:
        """Drop locks nobody holds, waits on, or has a session behind."""
        for key, lock in list(self._locks.items()):
            if not lock.locked() and key not in self._held:
                del self._locks[key]


class _Turn:
    """One conversation stream's model output, translated into ResultSink calls.

    Push-to-talk gets exactly one reply per stream. Continuous mode may get many: each
    turn_completed() or interrupted() settles the current reply and resets state so ids
    and accumulated text start fresh for the next one -- the two modes need no separate
    code path here, since push-to-talk's single reply is just the n=1 case of the same
    settle-then-reset cycle.
    """

    def __init__(
        self,
        result_sink: ResultSink,
        stream: StreamInfo,
        *,
        session: RealtimeSession,
        tools: ToolBox | None,
        audio_id_factory: Callable[[], str],
        reply_id_factory: Callable[[], str],
        message_id_factory: Callable[[], str],
        question_id_factory: Callable[[], str],
    ) -> None:
        """Start a stream that has heard nothing and said nothing yet."""
        self._result_sink = result_sink
        self._stream = stream
        self._session = session
        self._tools = tools
        self._audio_id_factory = audio_id_factory
        self._reply_id_factory = reply_id_factory
        self._message_id_factory = message_id_factory
        self._question_id_factory = question_id_factory
        # None between replies; assigned on first use so each reply gets a fresh id.
        self._audio_id: str | None = None
        # Survives the reset below so a late barge-in can still name the audio the
        # phone is playing -- the model finishes generating well before playback ends.
        self._last_audio_id: str | None = None
        self._reply_id: str | None = None
        self._spoken = ""
        self._purpose = REPLY_PURPOSE
        self._input_bytes = 0
        self._audio: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._speaking: asyncio.Task[None] | None = None
        self._ends_conversation = False
        self.failure: str | None = None

    def note_input_chunk(self, chunk_bytes: int) -> None:
        """Accumulate audio sent since the last transcript, for its reported duration.

        Continuous mode hears many transcripts per stream; each one's duration must
        reflect only the audio sent since the previous one, not the whole stream.
        """
        self._input_bytes += chunk_bytes

    async def heard(self, text: str) -> None:
        """Push what the user was heard to say."""
        if not text:
            logger.info("realtime model returned an empty transcript")
            self._input_bytes = 0
            return
        await self._result_sink.deliver_transcript(
            HeardSpeech(
                text=text,
                language=ASSUMED_LANGUAGE,
                duration_ms=self._input_bytes // _INPUT_BYTES_PER_MS,
            ),
            self._stream,
        )
        self._input_bytes = 0

    async def spoke(self, text: str) -> None:
        """Push the reply's wording so far, and keep it for the audio's opening message."""
        if self._reply_id is None:
            self._reply_id = self._reply_id_factory()
        self._spoken = text
        await self._result_sink.deliver_reply_text(
            ReplyText(reply_id=self._reply_id, speech_text=text), self._stream
        )

    async def audio(self, data: bytes) -> None:
        """Queue one chunk, starting the delivery on the first one."""
        if self._speaking is None:
            self._audio_id = self._audio_id_factory()
            self._last_audio_id = self._audio_id
            self._speaking = asyncio.create_task(self._speak())
        await self._audio.put(data)

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """Run the tool, tell the client what came of it, and let the model continue.

        The client needs the data to display and the model needs it to say anything true
        about it, so both are answered from the one call.
        """
        if self._tools is None:
            logger.warning(
                "realtime model asked for a tool while none are registered",
                extra={"call_id": call_id, "tool": name},
            )
            return

        result = await self._tools.run(name, arguments)
        if result.outcome is not None:
            outcome = result.outcome
            await self._result_sink.deliver_result(
                CommandResult(
                    message_id=self._message_id_factory(),
                    operation=str(outcome["operation"]),
                    status=str(outcome["status"]),
                    schedule=outcome.get("schedule"),
                    schedules=outcome.get("schedules"),
                    occurrence_overrides=outcome.get("occurrence_overrides"),
                ),
                self._stream,
            )
        if result.question is not None:
            await self._ask(result.question)
        if result.ends_conversation:
            self._ends_conversation = True
        # A tool that ends the conversation gets no follow-up reply: the model said its
        # goodbye in the response that called the tool, and asking for another one only
        # produces a second one -- which the vendor may start by cutting the first short.
        await self._session.send_tool_result(
            call_id, result.output, respond=not result.ends_conversation
        )

    async def _ask(self, question: dict[str, Any]) -> None:
        """Push a question and mark the reply as one, so the audio says which it is."""
        self._purpose = QUESTION_PURPOSE
        await self._result_sink.deliver_question(
            DialogueQuestion(
                question_id=self._question_id_factory(),
                question_kind=str(question["question_kind"]),
                speech_text=str(question["speech_text"]),
                required_response=question["required_response"],
                candidates=question["candidates"],
            ),
            self._stream,
        )

    async def turn_completed(self) -> None:
        """One reply on this stream finished normally; continuous mode only."""
        await self._finish_reply(canceled=False)

    async def interrupted(self) -> None:
        """The user spoke over this reply; the session has already cancelled it."""
        await self._finish_reply(canceled=True)

    async def failed(self, message: str) -> None:
        """Record that the session could not continue."""
        self.failure = message
        # The reason is interpolated into the message rather than passed via extra=:
        # this project's configured log format string does not reference extra fields,
        # so extra={"reason": message} alone would silently print no reason at all.
        logger.warning("realtime session failed: %s", message)
        # Continuous mode holds a full-screen call open until it is told the session
        # ended, and a failure ends it as surely as end_conversation does. Saying nothing
        # would leave that call up around a microphone nobody is reading any more.
        # Push-to-talk needs no such message: its stream ends on its own either way.
        if self._stream.voice_mode != "push_to_talk":
            self._ends_conversation = True

    async def close(self) -> None:
        """Settle whatever reply is in flight; a no-op if the last one already was."""
        await self._finish_reply(canceled=False)

    async def _finish_reply(self, *, canceled: bool) -> None:
        """Settle the current reply's wording, then its audio -- in that order; see
        close's test -- then reset so the next reply on this stream starts fresh.
        """
        if self._spoken:
            assert self._reply_id is not None
            await self._result_sink.deliver_reply_text(
                ReplyText(reply_id=self._reply_id, speech_text=self._spoken, done=True),
                self._stream,
            )
        if self._speaking is not None:
            if canceled:
                assert self._audio_id is not None
                await self._result_sink.deliver_canceled(
                    AudioCanceled(audio_id=self._audio_id), self._stream
                )
            await self._audio.put(None)
            await self._speaking
        elif canceled:
            # This reply's bytes were already all sent -- self._speaking settled on its
            # own before the barge-in arrived -- but the model generates audio faster
            # than it plays back, so the phone can still be sounding it out. The session
            # only calls interrupted() this late when its own playable-until estimate
            # says that's still plausible. Name the original audio so the client can
            # tell this stale cancellation apart from a newer reply already starting.
            if self._last_audio_id is not None:
                await self._result_sink.deliver_canceled(
                    AudioCanceled(audio_id=self._last_audio_id), self._stream
                )
        self._spoken = ""
        self._reply_id = None
        self._audio_id = None
        self._speaking = None
        self._purpose = REPLY_PURPOSE
        if self._ends_conversation:
            # Only after the settling above -- any farewell this reply spoke has already
            # gone out in full, so telling the client to hang up here never cuts it short.
            self._ends_conversation = False
            await self._result_sink.deliver_session_end(self._stream)

    async def _speak(self) -> None:
        """Hand the queued audio to the sink as one continuous reply."""
        assert self._audio_id is not None
        reply = AudioReply(
            audio_id=self._audio_id,
            audio_format=REPLY_AUDIO_FORMAT,
            sample_rate_hz=REPLY_SAMPLE_RATE_HZ,
            purpose=self._purpose,
            speech_text=self._spoken,
        )
        await self._result_sink.deliver_audio(reply, self._drain(), self._stream)

    async def _drain(self) -> AsyncIterator[bytes]:
        """Yield queued chunks until the reply is closed."""
        while True:
            chunk = await self._audio.get()
            if chunk is None:
                return
            yield chunk
