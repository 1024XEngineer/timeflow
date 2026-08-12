"""What the dialogue layer needs from a realtime speech model, on its own terms."""

from typing import Any, Protocol


class TurnObserver(Protocol):
    """What a realtime session reports while a turn runs, in this layer's own terms."""

    async def heard(self, text: str) -> None:
        """The model reported what the user said."""
        ...

    async def spoke(self, text: str) -> None:
        """The model reported the words it is saying."""
        ...

    async def audio(self, data: bytes) -> None:
        """One chunk of the model's own speech, already decoded to raw bytes."""
        ...

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """The model asked for a tool to run before it continues."""
        ...

    async def failed(self, message: str) -> None:
        """The session cannot continue."""
        ...


class RealtimeSession(Protocol):
    """One open conversation with a realtime speech model."""

    async def send_audio(self, chunk: bytes) -> None:
        """Hand one chunk of the user's speech to the model."""
        ...

    async def finish_input(self) -> None:
        """Tell the model the user stopped talking and a reply is wanted."""
        ...

    async def send_tool_result(self, call_id: str, output: str) -> None:
        """Return a tool's output and let the model continue from it."""
        ...

    async def pump(self, observer: TurnObserver) -> None:
        """Report what the model says until the turn ends or the session fails."""
        ...

    async def close(self) -> None:
        """Release the session."""
        ...


class RealtimeSessionFactory(Protocol):
    """Open a session per turn, so one failure never poisons the next."""

    async def open(self, instructions: str, tools: list[dict[str, Any]]) -> RealtimeSession:
        """Connect and configure a session; raises when the model is unreachable."""
        ...
