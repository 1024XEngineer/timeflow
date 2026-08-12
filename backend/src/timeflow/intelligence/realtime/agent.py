"""Agent that hands turns to a realtime speech model and reports what it says."""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from timeflow.intelligence.ports import (
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


@dataclass(slots=True)
class _Held:
    """A session kept open past its turn, so the next turn remembers this one."""

    session: RealtimeSession
    tools: ToolBox | None
    opened_at: float
    turns: int = 0


class RealtimeAgent:
    """Feed audio streams to a realtime model, one conversation at a time."""

    def __init__(
        self,
        sessions: RealtimeSessionFactory,
        result_sink: ResultSink,
        *,
        tools_factory: Callable[[str], ToolBox] | None = None,
        instructions: Callable[[], str] | None = None,
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
        self._instructions = instructions or (lambda: "")
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
        """Run one turn on the conversation's session, keeping it for the next turn."""
        key = (stream.account_id, stream.conversation_id)
        await self._close_spent()
        self._forget_idle_locks()

        async with self._lock_for(key):
            held = await self._session_for(key)
            if held is None:
                return

            turn = _Turn(
                self._result_sink,
                stream,
                self._audio_id_factory(),
                self._reply_id_factory(),
                session=held.session,
                tools=held.tools,
                message_id_factory=self._message_id_factory,
                question_id_factory=self._question_id_factory,
            )
            pumping = asyncio.create_task(held.session.pump(turn))
            reusable = False
            try:
                sent_bytes = 0
                async for chunk in chunks:
                    await held.session.send_audio(chunk)
                    sent_bytes += len(chunk)
                await held.session.finish_input()
                turn.note_input(sent_bytes)
                await pumping
                reusable = turn.failure is None
            except BaseException:
                # Cancelled on every exit, not just the caller's: an orphaned pump sits
                # in recv().
                pumping.cancel()
                with contextlib.suppress(BaseException):
                    await pumping
                raise
            finally:
                await turn.close()
                # Kept only after a turn it survived. A failure, an exception, or a client
                # that hung up mid-turn leaves state nobody has reasoned about, and
                # reusing it carries that into the next turn.
                if reusable:
                    held.turns += 1
                else:
                    await self._discard(key)

    async def _session_for(self, key: tuple[str, str]) -> _Held | None:
        """Return the conversation's open session, opening one when there is none."""
        held = self._held.get(key)
        if held is not None:
            return held

        account_id, _ = key
        tools = self._tools_factory(account_id) if self._tools_factory is not None else None
        schemas = tools.tools() if tools is not None else []
        try:
            session = await self._sessions.open(self._instructions(), schemas)
        except Exception:
            logger.exception("could not open a realtime session")
            return None
        fresh = _Held(session=session, tools=tools, opened_at=self._clock())
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
    """One turn's model output, translated into ResultSink calls as it arrives."""

    def __init__(
        self,
        result_sink: ResultSink,
        stream: StreamInfo,
        audio_id: str,
        reply_id: str,
        *,
        session: RealtimeSession,
        tools: ToolBox | None,
        message_id_factory: Callable[[], str],
        question_id_factory: Callable[[], str],
    ) -> None:
        """Start a turn that has heard nothing and said nothing."""
        self._result_sink = result_sink
        self._stream = stream
        self._audio_id = audio_id
        self._reply_id = reply_id
        self._session = session
        self._tools = tools
        self._message_id_factory = message_id_factory
        self._question_id_factory = question_id_factory
        self._spoken = ""
        self._purpose = REPLY_PURPOSE
        self._input_bytes = 0
        self._audio: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._speaking: asyncio.Task[None] | None = None
        self.failure: str | None = None

    def note_input(self, sent_bytes: int) -> None:
        """Record how much audio the user sent, for the transcript's duration."""
        self._input_bytes = sent_bytes

    async def heard(self, text: str) -> None:
        """Push what the user was heard to say."""
        if not text:
            logger.info("realtime model returned an empty transcript")
            return
        await self._result_sink.deliver_transcript(
            HeardSpeech(
                text=text,
                language=ASSUMED_LANGUAGE,
                duration_ms=self._input_bytes // _INPUT_BYTES_PER_MS,
            ),
            self._stream,
        )

    async def spoke(self, text: str) -> None:
        """Push the reply's wording so far, and keep it for the audio's opening message."""
        self._spoken = text
        await self._result_sink.deliver_reply_text(
            ReplyText(reply_id=self._reply_id, speech_text=text), self._stream
        )

    async def audio(self, data: bytes) -> None:
        """Queue one chunk, starting the delivery on the first one."""
        if self._speaking is None:
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
                ),
                self._stream,
            )
        if result.question is not None:
            await self._ask(result.question)
        await self._session.send_tool_result(call_id, result.output)

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

    async def failed(self, message: str) -> None:
        """Record that the model could not finish this turn."""
        self.failure = message
        logger.warning("realtime session failed", extra={"reason": message})

    async def close(self) -> None:
        """Settle the wording, then finish the audio -- in that order; see close's test."""
        if self._spoken:
            await self._result_sink.deliver_reply_text(
                ReplyText(reply_id=self._reply_id, speech_text=self._spoken, done=True),
                self._stream,
            )
        if self._speaking is None:
            return
        await self._audio.put(None)
        await self._speaking

    async def _speak(self) -> None:
        """Hand the queued audio to the sink as one continuous reply."""
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
