"""Driving a realtime model through one turn, with a scripted fake session."""

import asyncio
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
from timeflow.intelligence.realtime.agent import RealtimeAgent


@dataclass(frozen=True, slots=True)
class _Stream:
    """Identifiers of the audio stream a turn answers."""

    session_id: str = "ws_session_test"
    stream_id: str = "stream_test"
    conversation_id: str = "conversation_test"
    request_id: str | None = "req_voice_001"


@dataclass
class RecordingSink:
    """Record what the agent pushed, in order, resolving audio to bytes."""

    calls: list[tuple[str, Any]] = field(default_factory=list)

    async def deliver_transcript(self, transcript: Transcript, stream: Any) -> None:
        """Record what the user was heard to say."""
        self.calls.append(("transcript", transcript))

    async def deliver_reply_text(self, reply: ReplyText, stream: Any) -> None:
        """Record how much of the reply's wording had been settled."""
        self.calls.append(("done" if reply.done else "reply", reply.speech_text))

    async def deliver_result(self, result: CommandResult, stream: Any) -> None:
        """Record a command result."""
        self.calls.append(("result", result))

    async def deliver_question(self, question: DialogueQuestion, stream: Any) -> None:
        """Record a question put to the user."""
        self.calls.append(("question", question))

    async def deliver_audio(
        self, reply: AudioReply, chunks: AsyncIterator[bytes], stream: Any
    ) -> None:
        """Record the reply description, then drain its audio."""
        self.calls.append(("audio_start", reply))
        async for chunk in chunks:
            self.calls.append(("audio", chunk))
        self.calls.append(("audio_end", reply.audio_id))

    def kinds(self) -> list[str]:
        """Return just the kind of each recorded call."""
        return [kind for kind, _ in self.calls]


class ScriptedSession:
    """A session that replays a scripted sequence of observer calls."""

    def __init__(self, script: list[tuple[str, Any]]) -> None:
        """Store the script plus room to record what was sent."""
        self._script = script
        self.audio_sent: list[bytes] = []
        self.finished = False
        self.closed = False
        self.tool_results: list[tuple[str, str]] = []

    async def send_audio(self, chunk: bytes) -> None:
        """Record one chunk of the user's speech."""
        self.audio_sent.append(chunk)

    async def finish_input(self) -> None:
        """Record that the input was closed."""
        self.finished = True

    async def send_tool_result(self, call_id: str, output: str) -> None:
        """Record a tool result written back."""
        self.tool_results.append((call_id, output))

    async def close(self) -> None:
        """Record that the session was released."""
        self.closed = True

    async def pump(self, observer: Any) -> None:
        """Replay the script against the observer."""
        for kind, payload in self._script:
            await getattr(observer, kind)(*payload)


class ScriptedFactory:
    """Hand out one scripted session, recording how it was configured."""

    def __init__(self, session: ScriptedSession) -> None:
        """Store the session to hand out."""
        self._session = session
        self.instructions: str | None = None

    async def open(self, instructions: str, tools: list[dict[str, Any]]) -> ScriptedSession:
        """Record the configuration and return the scripted session."""
        self.instructions = instructions
        return self._session


class FailingFactory:
    """A factory that cannot reach the model."""

    async def open(self, instructions: str, tools: list[dict[str, Any]]) -> ScriptedSession:
        """Fail as an unreachable model would."""
        raise ConnectionRefusedError


async def _chunks(*payloads: bytes) -> AsyncIterator[bytes]:
    """Yield the given chunks with no delay."""
    for payload in payloads:
        yield payload


def test_a_turn_pushes_the_transcript_then_the_spoken_reply() -> None:
    """The user's words go out first, then the reply's audio framed by its text."""

    async def scenario() -> None:
        """Replay a turn that hears, speaks, and sends two audio chunks."""
        session = ScriptedSession(
            [
                ("heard", ("明天下午三点在203开会",)),
                ("spoke", ("好，",)),
                ("spoke", ("好，记下了",)),
                ("audio", (b"pcm-1",)),
                ("audio", (b"pcm-2",)),
            ]
        )
        sink = RecordingSink()

        await RealtimeAgent(ScriptedFactory(session), sink).handle_audio(
            _chunks(b"a" * 3200), _Stream()
        )

        # The wording goes out as it forms, ahead of the audio for it, and is settled once
        # at the end. Only the audio is framed by a start and an end.
        assert sink.kinds() == [
            "transcript",
            "reply",
            "reply",
            "audio_start",
            "audio",
            "audio",
            "done",
            "audio_end",
        ]
        assert [text for kind, text in sink.calls if kind in ("reply", "done")] == [
            "好，",
            "好，记下了",
            "好，记下了",
        ]
        heard = sink.calls[0][1]
        assert heard.text == "明天下午三点在203开会"
        assert heard.duration_ms == 100  # 3200 bytes at 16 kHz mono 16-bit
        assert [chunk for kind, chunk in sink.calls if kind == "audio"] == [b"pcm-1", b"pcm-2"]

    asyncio.run(scenario())


def test_the_reply_text_on_the_opening_message_is_the_text_known_by_then() -> None:
    """voice.tts.start carries the reply's words, gathered before the audio began.

    The model streams its own text well before the first audio chunk but only confirms it
    afterwards, so the opening message uses what has accumulated rather than waiting.
    """

    async def scenario() -> None:
        """Replay a turn whose text streams fully before any audio."""
        session = ScriptedSession(
            [
                ("spoke", ("好，",)),
                ("spoke", ("好，明天三点",)),
                ("spoke", ("好，明天三点记下了",)),
                ("audio", (b"pcm",)),
            ]
        )
        sink = RecordingSink()

        await RealtimeAgent(ScriptedFactory(session), sink).handle_audio(_chunks(b"a"), _Stream())

        reply = next(value for kind, value in sink.calls if kind == "audio_start")
        assert reply.speech_text == "好，明天三点记下了"
        assert reply.sample_rate_hz == 24000
        assert reply.audio_format == "pcm"
        assert reply.purpose == "command_result"

    asyncio.run(scenario())


def test_audio_goes_out_before_the_model_has_finished_speaking() -> None:
    """Each chunk is handed on as it arrives, not collected and sent at the end.

    Buffering would erase the latency the realtime model exists for, which is the one
    number the two candidate approaches are compared on.
    """

    async def scenario() -> None:
        """Check what the sink has seen from inside the model's own reporting."""
        seen_midway: list[str] = []
        sink = RecordingSink()

        class WatchingSession(ScriptedSession):
            """A session that inspects the sink between two audio chunks."""

            async def pump(self, observer: Any) -> None:
                """Report one chunk, look at the sink, then report another."""
                await observer.spoke("好")
                await observer.audio(b"first")
                await asyncio.sleep(0)
                seen_midway.extend(sink.kinds())
                await observer.audio(b"second")

        await RealtimeAgent(ScriptedFactory(WatchingSession([])), sink).handle_audio(
            _chunks(b"a"), _Stream()
        )

        assert seen_midway == ["reply", "audio_start", "audio"]

    asyncio.run(scenario())


def test_the_user_audio_reaches_the_model_unchanged_then_input_is_closed() -> None:
    """Chunks are forwarded byte for byte, and the model is told when to answer."""

    async def scenario() -> None:
        """Send three chunks and inspect what the session received."""
        session = ScriptedSession([])

        await RealtimeAgent(ScriptedFactory(session), RecordingSink()).handle_audio(
            _chunks(b"one", b"two", b"three"), _Stream()
        )

        assert session.audio_sent == [b"one", b"two", b"three"]
        assert session.finished is True
        # Closed at the end of the turn. Keeping it open so a follow-up can remember this
        # turn is what the round adding questions needs, and it lands with them.
        assert session.closed is True

    asyncio.run(scenario())


def test_the_instructions_are_applied_when_the_session_opens() -> None:
    """The assistant's role is set before any audio, as the vendor requires.

    Built per turn rather than stored: the instructions state the current date, and a
    server running for days would otherwise keep telling the model it is still day one.
    """

    async def scenario() -> None:
        """Open a turn with instructions and read them back."""
        factory = ScriptedFactory(ScriptedSession([]))

        await RealtimeAgent(
            factory, RecordingSink(), instructions=lambda: "你是日程助手"
        ).handle_audio(_chunks(b"a"), _Stream())

        assert factory.instructions == "你是日程助手"

    asyncio.run(scenario())


def test_an_empty_transcript_pushes_nothing() -> None:
    """A turn the model could not transcribe does not send an empty transcript."""

    async def scenario() -> None:
        """Replay a turn that heard nothing."""
        sink = RecordingSink()

        await RealtimeAgent(
            ScriptedFactory(ScriptedSession([("heard", ("",))])), sink
        ).handle_audio(_chunks(b"a"), _Stream())

        assert sink.calls == []

    asyncio.run(scenario())


def test_a_turn_with_no_audio_reply_sends_no_tts_messages() -> None:
    """A text-only reply does not open an audio run that would never be filled.

    Its wording still goes out: that is the point of carrying text separately from the
    audio, so a reply the model never spoke aloud still reaches the user.
    """

    async def scenario() -> None:
        """Replay a turn that speaks but produces no audio."""
        sink = RecordingSink()

        await RealtimeAgent(
            ScriptedFactory(ScriptedSession([("heard", ("在吗",)), ("spoke", ("在",))])), sink
        ).handle_audio(_chunks(b"a"), _Stream())

        assert sink.kinds() == ["transcript", "reply", "done"]
        assert not [kind for kind in sink.kinds() if kind.startswith("audio")]

    asyncio.run(scenario())


def test_an_unreachable_model_does_not_raise_into_the_transport() -> None:
    """A model that cannot be opened ends the turn quietly; the session stays usable.

    The audio sink runs in a background task whose exceptions are only logged, so raising
    here would lose the reason and leave the client waiting with no explanation either way.
    """

    async def scenario() -> None:
        """Run a turn against a factory that refuses to connect."""
        sink = RecordingSink()

        await RealtimeAgent(FailingFactory(), sink).handle_audio(_chunks(b"a"), _Stream())

        assert sink.calls == []

    asyncio.run(scenario())


def test_a_failing_session_still_closes_the_audio_it_started() -> None:
    """A reply cut short is still closed, so the client is not left waiting."""

    async def scenario() -> None:
        """Replay a turn that sends one chunk and then fails."""
        session = ScriptedSession(
            [("spoke", ("好",)), ("audio", (b"pcm",)), ("failed", ("quota exceeded",))]
        )
        sink = RecordingSink()

        await RealtimeAgent(ScriptedFactory(session), sink).handle_audio(_chunks(b"a"), _Stream())

        # Both runs are closed, not just the audio: a client showing the wording as it
        # arrives needs to be told it is final, or a reply cut short reads as still coming.
        # The settling update comes before audio_end, which is what ends the turn.
        assert sink.kinds() == ["reply", "audio_start", "audio", "done", "audio_end"]

    asyncio.run(scenario())


def test_the_wording_is_settled_before_the_audio_closes_the_turn() -> None:
    """The settling update precedes voice.tts.end, because that message ends the turn.

    Found on the real model: with the order reversed, a client that stops reading once the
    audio run closes -- the reasonable reading of the protocol -- never sees the wording
    marked final, and goes on showing an answer as still arriving.
    """

    async def scenario() -> None:
        """Replay a turn that speaks and sends audio, then inspect the tail."""
        sink = RecordingSink()
        session = ScriptedSession([("spoke", ("在",)), ("audio", (b"pcm",))])

        await RealtimeAgent(ScriptedFactory(session), sink).handle_audio(_chunks(b"a"), _Stream())

        kinds = sink.kinds()
        assert kinds[-1] == "audio_end"
        assert kinds.index("done") < kinds.index("audio_end")

    asyncio.run(scenario())


def test_a_failure_while_sending_audio_does_not_leave_the_pump_running() -> None:
    """The pump is cancelled on any exit, not only on the caller being cancelled."""

    class BlockingSession(ScriptedSession):
        """A session whose pump waits forever unless it is cancelled."""

        def __init__(self) -> None:
            """Start with nothing scripted and no cancellation seen."""
            super().__init__([])
            self.pump_cancelled = False

        async def pump(self, observer: Any) -> None:
            """Wait to be cancelled, recording that it was."""
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.pump_cancelled = True
                raise

    async def failing_chunks() -> AsyncIterator[bytes]:
        """Yield one chunk, let the pump start, then fail as a broken stream would."""
        yield b"a"
        await asyncio.sleep(0)
        raise RuntimeError("the inbound stream broke")

    async def scenario() -> None:
        """Run a turn whose audio source fails partway."""
        session = BlockingSession()

        try:
            await RealtimeAgent(ScriptedFactory(session), RecordingSink()).handle_audio(
                failing_chunks(), _Stream()
            )
        except RuntimeError as error:
            assert "inbound stream broke" in str(error)
        else:
            raise AssertionError("expected the stream failure to reach the caller")

        assert session.pump_cancelled is True
        assert session.closed is True

    asyncio.run(scenario())
