"""Agent that hands one turn to a realtime speech model and reports what it says."""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any
from uuid import uuid4

from timeflow.intelligence.ports import AudioReply, ReplyText, ResultSink, StreamInfo
from timeflow.intelligence.ports import Transcript as HeardSpeech
from timeflow.intelligence.realtime.ports import RealtimeSessionFactory

logger = logging.getLogger(__name__)

# The model emits 24 kHz mono PCM; the client is told so in voice.tts.start.
REPLY_SAMPLE_RATE_HZ = 24_000
REPLY_AUDIO_FORMAT = "pcm"

# Why the reply is being spoken. Only answers exist this round; a question sounds the same
# on the wire, so the round that adds them will set this per turn instead.
REPLY_PURPOSE = "command_result"

# Language is reported as the model's own, not detected here.
ASSUMED_LANGUAGE = "zh"

# 16 kHz mono 16-bit: 32 bytes per millisecond.
_INPUT_BYTES_PER_MS = 32


def new_audio_id() -> str:
    """Return a fresh identifier for one spoken reply."""
    return f"audio_{uuid4().hex}"


def new_reply_id() -> str:
    """Return a fresh identifier tying one reply's wording updates together."""
    return f"reply_{uuid4().hex}"


class RealtimeAgent:
    """Feed one audio stream to a realtime model and push back what comes out."""

    def __init__(
        self,
        sessions: RealtimeSessionFactory,
        result_sink: ResultSink,
        *,
        instructions: Callable[[], str] | None = None,
        audio_id_factory: Callable[[], str] | None = None,
        reply_id_factory: Callable[[], str] | None = None,
    ) -> None:
        """Store the session source, the sink, and the id seams."""
        self._sessions = sessions
        self._result_sink = result_sink
        # Called per turn rather than stored, so a server running for days keeps telling
        # the model what day it is now rather than what day it started.
        self._instructions = instructions or (lambda: "")
        self._audio_id_factory = audio_id_factory or new_audio_id
        self._reply_id_factory = reply_id_factory or new_reply_id

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Run one turn: send the audio, then push the transcript, wording and speech."""
        try:
            session = await self._sessions.open(self._instructions(), [])
        except Exception:
            # Returning rather than raising: the transport only asked us to take the audio,
            # and a model we cannot reach is not a transport fault to report as one.
            logger.exception("could not open a realtime session")
            return

        turn = _Turn(
            self._result_sink,
            stream,
            self._audio_id_factory(),
            self._reply_id_factory(),
        )
        pumping = asyncio.create_task(session.pump(turn))
        try:
            sent_bytes = 0
            async for chunk in chunks:
                await session.send_audio(chunk)
                sent_bytes += len(chunk)
            await session.finish_input()
            turn.note_input(sent_bytes)
            await pumping
        except asyncio.CancelledError:
            pumping.cancel()
            raise
        finally:
            await turn.close()
            await session.close()


class _Turn:
    """One turn's worth of model output, translated into ResultSink calls.

    Exists because the two sides disagree about who drives. The session reports by
    calling methods; ResultSink.deliver_audio wants to pull an iterator. A queue in
    between lets audio go out chunk by chunk as it arrives, instead of being collected
    and sent once the reply is over.
    """

    def __init__(
        self,
        result_sink: ResultSink,
        stream: StreamInfo,
        audio_id: str,
        reply_id: str,
    ) -> None:
        """Start a turn that has heard nothing and said nothing."""
        self._result_sink = result_sink
        self._stream = stream
        self._audio_id = audio_id
        self._reply_id = reply_id
        self._spoken = ""
        self._input_bytes = 0
        self._audio: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._speaking: asyncio.Task[None] | None = None

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
        """Push the reply's wording, and keep it for the audio's opening message.

        The session already reports accumulations rather than fragments, which is the shape
        ReplyText wants, so this forwards them as they come. Measured against the real
        model the wording finishes about 600 ms before the first audio chunk arrives, so
        holding it back until the audio starts would waste that whole gap.
        """
        self._spoken = text
        await self._result_sink.deliver_reply_text(
            ReplyText(reply_id=self._reply_id, speech_text=text), self._stream
        )

    async def audio(self, data: bytes) -> None:
        """Queue one chunk, starting the delivery on the first one.

        Delivery starts here rather than at the top of the turn because the opening message
        carries the reply's text, and that is only known once the model has begun speaking.
        """
        if self._speaking is None:
            self._speaking = asyncio.create_task(self._speak())
        await self._audio.put(data)

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """Note that a tool was asked for while none are offered.

        No tools are registered this round, so the model should not be asking. It is
        logged rather than answered: writing an invented result back would have it speak
        about schedules that were never looked up.
        """
        del arguments
        logger.warning(
            "realtime model asked for a tool while none are registered",
            extra={"call_id": call_id, "tool": name},
        )

    async def failed(self, message: str) -> None:
        """Record that the model could not finish this turn."""
        logger.warning("realtime session failed", extra={"reason": message})

    async def close(self) -> None:
        """Settle the reply's wording, then finish the audio if any started.

        The settling update has to precede the audio's closing message, because that
        message is what ends a turn: a client that stops reading on voice.tts.end -- the
        reasonable thing to do -- would never see an update sent after it. The wording is
        in fact final well before this point; the session reports no completion for it, so
        the end of the turn is the earliest moment this side can be sure.
        """
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
            purpose=REPLY_PURPOSE,
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
