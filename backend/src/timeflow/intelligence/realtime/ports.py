"""What the dialogue layer needs from a realtime speech model, on its own terms."""

from typing import Any, Protocol


class TurnObserver(Protocol):
    """What a realtime session reports while a turn runs, in this layer's own terms."""

    async def heard(self, text: str, turn_id: str | None = None) -> None:
        """The model reported what the user said, and which utterance it transcribes."""
        ...

    async def user_started_speaking(self) -> None:
        """The vendor detected user speech, including a barge-in."""
        ...

    async def spoke(self, text: str, turn_id: str | None = None) -> None:
        """The model reported the words it is saying, and which utterance they answer."""
        ...

    async def audio(self, data: bytes) -> None:
        """One chunk of the model's own speech, already decoded to raw bytes."""
        ...

    async def tool_requested(
        self, call_id: str, name: str, arguments: dict[str, Any], turn_id: str | None = None
    ) -> None:
        """The model asked for a tool to run before it continues answering one utterance."""
        ...

    async def turn_completed(self) -> None:
        """One reply finished. Only meaningful in continuous mode, where more may follow
        on the same stream; push-to-talk's one reply per stream ends by pump() returning.
        """
        ...

    async def interrupted(self) -> None:
        """The user started speaking over an in-progress reply, which was cancelled.

        Continuous mode only -- push-to-talk has no reply in progress to interrupt.
        """
        ...

    async def failed(self, message: str) -> None:
        """The session cannot continue."""
        ...

    async def usage_reported(self, usage: dict[str, Any]) -> None:
        """One response finished; report the tokens the vendor says it cost."""
        ...


class RealtimeSession(Protocol):
    """One open conversation with a realtime speech model."""

    async def send_audio(self, chunk: bytes) -> None:
        """Hand one chunk of the user's speech to the model."""
        ...

    async def finish_input(self) -> None:
        """Tell the model the user stopped talking and a reply is wanted.

        Push-to-talk only: continuous mode's vendor VAD decides this for itself, so this
        is a no-op there.
        """
        ...

    async def send_tool_result(self, call_id: str, output: str, *, respond: bool = True) -> None:
        """Return a tool's output and let the model continue from it.

        respond=False writes the output back without asking for a further reply, for a
        tool whose whole point is that there is nothing left to say (end_conversation).
        """
        ...

    async def cancel_response(self) -> None:
        """Abandon whatever reply is in flight, if any.

        Continuous mode only -- called when the microphone closes while the model is
        still replying, so the vendor stops generating it instead of continuing to
        stream it into a session that may be reused for the next turn.
        """
        ...

    async def pump(self, observer: TurnObserver) -> None:
        """Report what the model says.

        Push-to-talk: returns once the one reply this stream asked for is done.
        Continuous mode: keeps running for the life of the stream, reporting one
        turn_completed() per reply -- the caller stops it once input ends.
        """
        ...

    async def close(self) -> None:
        """Release the session."""
        ...


class RealtimeSessionFactory(Protocol):
    """Open a session per turn, so one failure never poisons the next."""

    async def open(
        self, instructions: str, tools: list[dict[str, Any]], voice_mode: str
    ) -> RealtimeSession:
        """Connect and configure a session; raises when the model is unreachable."""
        ...
