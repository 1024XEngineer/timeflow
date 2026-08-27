"""Aliyun Qwen-Audio realtime adapter: speaks the vendor's wire format, reports plainly."""

import asyncio
import base64
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from timeflow.infrastructure.observability.external import ExternalCall
from timeflow.infrastructure.observability.metrics import (
    REALTIME_CONNECT_DURATION,
    REALTIME_CONNECTIONS,
    REALTIME_EVENTS,
    bound_realtime_event,
)

logger = logging.getLogger(__name__)

# Our protocol owns turn boundaries in this mode; the model must not also decide when a
# turn ended. Continuous mode hands that decision to the vendor's own VAD instead.
PUSH_TO_TALK = "push_to_talk"
CONTINUOUS = "continuous"

# The model accepts 16 kHz mono PCM in and emits 24 kHz mono PCM out.
INPUT_SAMPLE_RATE_HZ = 16_000
OUTPUT_SAMPLE_RATE_HZ = 24_000
# 16-bit mono at the output rate: bytes of PCM per second of actual playback time.
_OUTPUT_BYTES_PER_SECOND = OUTPUT_SAMPLE_RATE_HZ * 2
_REALTIME_EVENT_KINDS = {
    "conversation.item.input_audio_transcription.completed": "input_transcript",
    "response.audio_transcript.delta": "output_transcript",
    "response.audio_transcript.done": "output_transcript",
    "response.audio.delta": "audio",
    "response.function_call_arguments.done": "tool",
    "response.done": "response_done",
    "error": "error",
}


class Transport(Protocol):
    """The subset of a WebSocket this adapter uses, so tests can supply their own."""

    async def send(self, message: str) -> None:
        """Send one text frame."""
        ...

    async def recv(self) -> str | bytes:
        """Receive the next frame."""
        ...

    async def close(self) -> None:
        """Close the connection."""
        ...


class Observer(Protocol):
    """Where this adapter reports what the model says; restated, never imported."""

    async def heard(self, text: str) -> None:
        """The model reported what the user said."""
        ...

    async def user_started_speaking(self) -> None:
        """The vendor detected user speech, including a barge-in."""
        ...

    async def spoke(self, text: str) -> None:
        """The model reported the words it is saying."""
        ...

    async def audio(self, data: bytes) -> None:
        """One chunk of the model's own speech, decoded to raw bytes."""
        ...

    async def tool_requested(self, call_id: str, name: str, arguments: dict[str, Any]) -> None:
        """The model asked for a tool to run."""
        ...

    async def turn_completed(self) -> None:
        """One reply finished; continuous mode only, more may follow on this stream."""
        ...

    async def interrupted(self) -> None:
        """The user spoke over an in-progress reply, which was cancelled."""
        ...

    async def failed(self, message: str) -> None:
        """The session cannot continue."""
        ...

    async def usage_reported(self, usage: dict[str, Any]) -> None:
        """One response finished; report the tokens the vendor says it cost."""
        ...


@dataclass(frozen=True, slots=True)
class QwenAudioConfig:
    """Where to reach the model and how to authenticate."""

    api_key: str
    workspace_id: str
    model: str
    region: str = "cn-beijing"
    voice: str = "longanqian"
    # What continuous mode uses server-side; push-to-talk ignores these three.
    turn_detection: str = "smart_turn"
    vad_threshold: float = 0.5
    vad_silence_duration_ms: int = 800
    # How many past QA turns the vendor folds into inference. Continuous mode keeps a
    # short window rather than the vendor's 20-turn default: a voice conversation with
    # this agent is short-lived, and a longer window only adds token cost and latency
    # for context nobody asked to keep. Push-to-talk, one request in and out, keeps less
    # still -- see max_history_turns_push_to_talk.
    max_history_turns: int = 10
    max_history_turns_push_to_talk: int = 5

    def url(self) -> str:
        """Build the region- and workspace-specific realtime endpoint."""
        host = f"{self.workspace_id}.{self.region}.maas.aliyuncs.com"
        return f"wss://{host}/api-ws/v1/realtime?model={self.model}"

    def headers(self) -> dict[str, str]:
        """Build the auth headers; the key never appears in logs or errors."""
        return {"Authorization": f"Bearer {self.api_key}"}


def turn_detection_for(voice_mode: str, config: QwenAudioConfig) -> dict[str, Any] | None:
    """Build the vendor's turn_detection object for a voice mode.

    The client only ever picks push_to_talk vs continuous; which VAD backs continuous
    is a deployment knob (QwenAudioConfig.turn_detection), not something the client states.
    """
    if voice_mode != CONTINUOUS:
        return None
    if config.turn_detection == "server_vad":
        return {
            "type": "server_vad",
            "threshold": config.vad_threshold,
            "silence_duration_ms": config.vad_silence_duration_ms,
        }
    return {"type": "smart_turn"}


class QwenAudioSession:
    """One conversation with the model, translated to domain events.

    Push-to-talk: one stream is one reply. Continuous mode: one stream may carry many
    replies, each bounded by the vendor's own turn_detection rather than our finish_input.
    """

    def __init__(
        self,
        transport: Transport,
        config: QwenAudioConfig,
        voice_mode: str,
        *,
        clock: Callable[[], float] | None = None,
    ) -> None:
        """Store the open transport, the config it was opened with, and its voice mode."""
        self._transport = transport
        self._config = config
        self._voice_mode = voice_mode
        self._clock = clock or time.monotonic
        # A tool call makes one turn into two (or more) vendor responses -- the one that
        # ran the tool, then whatever response.create it triggered actually carries the
        # reply. Both pump loops use this to wait for the last one before settling.
        self._open_responses = 0
        # Set by send_tool_result() while the response that requested the tool(s) is
        # still in progress; consumed at that response's own response.done (see the two
        # pump loops). A batch turn can carry several function calls in one response --
        # asking for the follow-up as each tool finishes, instead of once the response
        # itself is done, would send response.create while the vendor still considers
        # that response in progress and it rejects the request outright.
        self._followup_requested = False
        # Set instead of _followup_requested when a tool in the current response ended
        # the conversation: no follow-up is wanted even if an earlier tool call in the
        # same batch asked for one.
        self._followup_suppressed = False
        # Continuous mode only: true between a response.created and its matching
        # response.done (or a cancellation). cancel_response() reads this to know
        # whether there is anything to tell the vendor to abandon.
        self._responding = False
        # Bytes of this reply's audio sent to the client so far, and the clock reading
        # past which its playback is assumed to have finished. The vendor generates audio
        # faster than it plays back, so response.done -- and _responding turning False --
        # only means the bytes were all sent, not that the phone is done sounding them
        # out. A barge-in landing in that gap is still a real barge-in.
        self._reply_bytes = 0
        self._playable_until = 0.0
        # Monotonic stage stamps for one response's vendor-side latency, reported on the
        # usage event at response.done. None until the matching vendor event arrives.
        self._speech_started_at: float | None = None
        self._response_started_at: float | None = None
        self._first_audio_at: float | None = None
        # Diagnostic only: counts every response.create we send against every
        # response.created the vendor reports back.
        self._responses_sent = 0
        self._responses_created = 0
        # Continuous mode only: true once real user speech has started a reply we are
        # legitimately waiting on, or a tool result has asked for a follow-up; false again
        # the instant that reply settles. The vendor has been observed to start an extra
        # response.created on its own -- no new speech_started, nothing asked for --
        # sometimes minutes after a reply already settled, re-answering the same query
        # under a fresh reply_id. _pump_continuous cancels a response.created it sees
        # while this is false, before any of its text or audio can reach the client.
        self._expecting_response = False
        # True from the moment cancel_response() sends response.cancel until a new
        # response actually starts. A cancel can race a response that the vendor was
        # already finishing on its own -- observed in production as an "error" event
        # back, "Conversation has no active response" -- which _pump_continuous would
        # otherwise treat as fatal and hang up the whole call over a no-op. Held open
        # until response.created rather than cleared on the next event, because the
        # vendor having finished that response is exactly what makes its response.done
        # arrive in between: a one-event allowance is spent on that response.done and
        # never reaches the error it was meant for.
        self._cancel_pending = False

    async def configure(self, instructions: str, tools: list[dict[str, Any]]) -> None:
        """Set the session up before any audio; turn_detection only takes effect here."""
        max_history_turns = (
            self._config.max_history_turns_push_to_talk
            if self._voice_mode == PUSH_TO_TALK
            else self._config.max_history_turns
        )
        session: dict[str, Any] = {
            "modalities": ["text", "audio"],
            "voice": self._config.voice,
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "turn_detection": turn_detection_for(self._voice_mode, self._config),
            "max_history_turns": max_history_turns,
        }
        if instructions:
            session["instructions"] = instructions
        if tools:
            session["tools"] = tools
        await self._send({"type": "session.update", "session": session})

    async def send_audio(self, chunk: bytes) -> None:
        """Append one chunk of the user's speech, base64 encoded as the vendor expects."""
        await self._send(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }
        )

    async def finish_input(self) -> None:
        """Commit the buffered audio and ask for a reply.

        Continuous mode's vendor VAD decides this for itself; committing or asking here
        too would race the vendor's own turn and double up the reply.
        """
        if self._voice_mode != PUSH_TO_TALK:
            return
        await self._send({"type": "input_audio_buffer.commit"})
        await self._send({"type": "response.create"})
        self._open_responses += 1
        self._responses_sent += 1

    async def send_tool_result(self, call_id: str, output: str, *, respond: bool = True) -> None:
        """Write a tool's output back and mark whether it should be followed by a reply.

        The output is written back either way, so the vendor's conversation history stays
        complete for later turns. Asking for a reply is separate, and deliberately deferred:
        response.create is required in every mode when one is wanted -- the vendor's own
        turn_detection only starts a turn from the user's audio, never from a tool result on
        its own -- but the response that requested this tool may still be in progress (a
        batch turn can call several tools before that response is done), and the vendor
        rejects a response.create sent while another response is still open. The two pump
        loops send it exactly once, at that response's own response.done, once every tool
        call belonging to it has been recorded here. A tool that ends the conversation has
        nothing to follow up, and asking anyway just buys a second goodbye on top of the one
        the model already spoke -- that takes priority over any other tool in the same batch
        that asked for a reply.
        """
        await self._send(
            {
                "type": "conversation.item.create",
                "item": {"type": "function_call_output", "call_id": call_id, "output": output},
            }
        )
        if respond:
            self._followup_requested = True
            self._expecting_response = True
        else:
            self._followup_suppressed = True

    async def cancel_response(self) -> None:
        """Tell the vendor to abandon its in-flight reply, if there is one.

        The caller (mic closed, continuous mode) is about to stop reading events on
        this session. Without this, the vendor keeps streaming the abandoned reply
        into the same socket; since the session gets reused, those frames -- and a
        stale nonzero _open_responses -- would otherwise bleed into the next turn's
        pump instead of being discarded.
        """
        if not self._responding:
            return
        self._responding = False
        self._open_responses = 0
        self._followup_requested = False
        self._followup_suppressed = False
        await self._send({"type": "response.cancel"})
        self._cancel_pending = True

    async def close(self) -> None:
        """Close the underlying connection, ignoring an already-closed one."""
        try:
            await self._transport.close()
        except Exception:  # noqa: BLE001 - closing must not mask the original outcome
            logger.debug("closing a realtime session that was already gone")

    async def _send(self, event: dict[str, Any]) -> None:
        """Serialize and send one client event."""
        await self._transport.send(json.dumps(event, ensure_ascii=False))

    def _latency_report(self) -> dict[str, float | None]:
        """Measure what the vendor's own timing this response exposes, in ms.

        Only the boundaries that actually arrived are measured; a response the vendor
        cut short reports what there is and leaves the rest None (rendered n/a). The
        VAD start only exists in continuous mode, where the vendor owns turn detection.
        """
        started = self._response_started_at
        if started is None:
            return {
                "latency_vad_ms": None,
                "latency_first_audio_ms": None,
                "latency_response_ms": None,
            }
        return {
            "latency_vad_ms": (
                round((started - self._speech_started_at) * 1000, 1)
                if self._speech_started_at is not None and self._voice_mode == CONTINUOUS
                else None
            ),
            "latency_first_audio_ms": (
                round((self._first_audio_at - started) * 1000, 1)
                if self._first_audio_at is not None
                else None
            ),
            "latency_response_ms": round((self._clock() - started) * 1000, 1),
        }

    async def pump(self, observer: Observer) -> None:
        """Report what the model says until the stream ends or fails."""
        async with ExternalCall("realtime", "pump"):
            if self._voice_mode == PUSH_TO_TALK:
                await self._pump_single_turn(observer)
            else:
                await self._pump_continuous(observer)

    async def _pump_single_turn(self, observer: Observer) -> None:
        """Report the one reply this stream asked for, decoded and renamed."""
        spoken = ""
        while True:
            event = await self._next_event(observer)
            if event is None:
                return
            kind = event.get("type")

            if kind == "conversation.item.input_audio_transcription.completed":
                await observer.heard(str(event.get("transcript", "")))
            elif kind == "response.created":
                self._responses_created += 1
                if self._responses_created > self._responses_sent:
                    logger.warning(
                        "realtime vendor started a response we never requested "
                        "(push_to_talk): sent=%s created=%s",
                        self._responses_sent,
                        self._responses_created,
                    )
                self._response_started_at = self._clock()
            elif kind == "response.audio_transcript.delta":
                spoken += str(event.get("delta", ""))
                await observer.spoke(spoken)
            elif kind == "response.audio_transcript.done":
                # Reported again in case the reply was short enough to skip increments.
                final = str(event.get("transcript", ""))
                if final and final != spoken:
                    spoken = final
                    await observer.spoke(spoken)
            elif kind == "response.audio.delta":
                decoded = _decode_audio(event.get("delta"))
                if decoded:
                    if self._first_audio_at is None:
                        self._first_audio_at = self._clock()
                    await observer.audio(decoded)
            elif kind == "response.function_call_arguments.done":
                requested = _tool_request(event)
                if requested is None:
                    await observer.failed("realtime session sent an unusable tool call")
                    return
                await observer.tool_requested(**requested)
            elif kind == "response.done":
                usage = _parse_usage(event)
                if usage is not None:
                    usage.update(self._latency_report())
                    await observer.usage_reported(usage)
                self._response_started_at = None
                self._first_audio_at = None
                # Not the turn's end if a tool asked for a follow-up: the next response
                # is the one that speaks. A tool that ended the conversation instead
                # (respond=False, _followup_suppressed) has no follow-up coming -- that
                # must fall through to the normal settlement below, not skip it, or the
                # turn never ends and the next recv() reads past the finished stream.
                self._open_responses -= 1
                wants_followup = self._followup_requested and not self._followup_suppressed
                self._followup_requested = False
                self._followup_suppressed = False
                if wants_followup:
                    logger.info("realtime sending follow-up response.create after a tool result")
                    await self._send({"type": "response.create"})
                    self._open_responses += 1
                    self._responses_sent += 1
                    continue
                if self._open_responses <= 0:
                    return
            elif kind == "error":
                await observer.failed(_error_message(event))
                return

    async def _pump_continuous(self, observer: Observer) -> None:
        """Report every reply on this stream, watching for the user talking over one.

        Never returns on its own -- the vendor, not a commit/response.create from us,
        decides when each reply starts. The caller stops this by cancelling the pump task
        once the stream's input ends, same as any other in-flight work it owns.
        """
        spoken = ""
        self._responding = False
        # A held session serves this conversation's next stream too, so everything this
        # loop reasons about has to start over here rather than carry the last stream's
        # answers into a call that has heard nothing yet: an expectation left standing
        # would wave through the first spontaneous response, and a playback estimate
        # left standing would report the opening speech_started as a barge-in on a reply
        # from the previous call. Within one stream `suppressed` shadows a stale estimate;
        # across streams nothing does. A follow-up already asked for and not yet delivered
        # is the one expectation that legitimately outlives the loop that created it.
        self._expecting_response = self._followup_requested
        self._playable_until = 0.0
        self._reply_bytes = 0
        self._cancel_pending = False
        # True from the moment we cancel a reply until the next one starts: the vendor
        # may still emit a few queued deltas for the cancelled reply before it catches up.
        suppressed = False
        while True:
            event = await self._next_event(observer)
            if event is None:
                return
            kind = event.get("type")

            if kind == "input_audio_buffer.speech_started":
                self._speech_started_at = self._clock()
                self._expecting_response = True
                # A real barge-in even once generation has finished: the phone can still
                # be sounding out audio that was already fully sent (see _playable_until).
                await observer.user_started_speaking()
                if not suppressed and (self._responding or self._clock() < self._playable_until):
                    suppressed = True
                    await self.cancel_response()
                    await observer.interrupted()
            elif kind == "response.created":
                self._responses_created += 1
                # A response is running again, so any cancel still awaiting its verdict
                # is settled: whatever the vendor says from here on is about this one.
                self._cancel_pending = False
                if not self._expecting_response:
                    logger.warning(
                        "realtime vendor started a response with no user speech or "
                        "requested follow-up behind it -- cancelling it before its "
                        "content can reach the client"
                    )
                    suppressed = True
                    self._responding = True
                    await self.cancel_response()
                    continue
                self._responding = True
                suppressed = False
                spoken = ""
                self._reply_bytes = 0
                self._response_started_at = self._clock()
                self._first_audio_at = None
            elif kind == "conversation.item.input_audio_transcription.completed":
                await observer.heard(str(event.get("transcript", "")))
            elif kind == "response.audio_transcript.delta" and not suppressed:
                spoken += str(event.get("delta", ""))
                await observer.spoke(spoken)
            elif kind == "response.audio_transcript.done" and not suppressed:
                final = str(event.get("transcript", ""))
                if final and final != spoken:
                    spoken = final
                    await observer.spoke(spoken)
            elif kind == "response.audio.delta" and not suppressed:
                decoded = _decode_audio(event.get("delta"))
                if decoded:
                    self._reply_bytes += len(decoded)
                    if self._first_audio_at is None:
                        self._first_audio_at = self._clock()
                    await observer.audio(decoded)
            elif kind == "response.function_call_arguments.done":
                requested = _tool_request(event)
                if requested is None:
                    await observer.failed("realtime session sent an unusable tool call")
                    return
                await observer.tool_requested(**requested)
            elif kind == "response.done":
                usage = _parse_usage(event)
                if usage is not None:
                    usage.update(self._latency_report())
                    await observer.usage_reported(usage)
                self._response_started_at = None
                self._first_audio_at = None
                if self._open_responses > 0:
                    self._open_responses -= 1
                # A tool call inside the response that just finished may have asked for
                # a follow-up; ask for it only now that the vendor considers this
                # response done (see send_tool_result). That follow-up, not this
                # response, is what actually finishes the turn -- settling here would
                # let a caller like end_conversation hang up before the model's actual
                # reply to it has even started. Same pattern as _pump_single_turn's
                # push-to-talk handling below. A tool that ended the conversation
                # instead (respond=False, _followup_suppressed) has no follow-up
                # coming, so it must NOT take this branch -- it needs the normal
                # settlement below to actually report turn_completed and let the
                # caller close out the call.
                wants_followup = self._followup_requested and not self._followup_suppressed
                self._followup_requested = False
                self._followup_suppressed = False
                if wants_followup:
                    logger.info("realtime sending follow-up response.create after a tool result")
                    await self._send({"type": "response.create"})
                    self._open_responses += 1
                    self._responses_sent += 1
                    continue
                self._responding = False
                # Not reset when suppressed: this response.done is the trailing tail of a
                # reply a barge-in already cancelled, and that barge-in's own
                # speech_started is what set this true -- the new reply it is about to
                # start is exactly what we are still legitimately waiting on.
                if not suppressed:
                    self._expecting_response = False
                # The bytes just sent still take this long to actually play out on the
                # phone; a barge-in landing before then is still cancelling something
                # audible, even though generation itself has already finished.
                self._playable_until = self._clock() + self._reply_bytes / _OUTPUT_BYTES_PER_SECOND
                await observer.turn_completed()
            elif kind == "error":
                if self._cancel_pending and _is_benign_cancel_race(event):
                    self._cancel_pending = False
                    logger.info(
                        "realtime response.cancel raced a response the vendor had "
                        "already finished on its own -- nothing to actually cancel, "
                        "continuing the call"
                    )
                    continue
                await observer.failed(_error_message(event))
                return

    async def _next_event(self, observer: Observer) -> dict[str, Any] | None:
        """Receive and parse one vendor frame, reporting failure and returning None on any
        problem so both pump loops can `return` from a single check.
        """
        try:
            raw = await self._transport.recv()
        except Exception as error:  # noqa: BLE001 - any transport failure ends the stream
            await observer.failed(f"realtime transport failed: {type(error).__name__}")
            return None

        if isinstance(raw, bytes):
            # The vendor sends everything as JSON text; a binary frame is unexpected, but
            # not fatal -- the caller loops around and waits for the next frame.
            return {}
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            await observer.failed("realtime session sent a non-JSON frame")
            return None
        if not isinstance(event, dict):
            await observer.failed("realtime session sent a non-object frame")
            return None
        kind = event.get("type")
        if isinstance(kind, str):
            REALTIME_EVENTS.labels(
                bound_realtime_event(_REALTIME_EVENT_KINDS.get(kind, "other"))
            ).inc()
        return event


def _decode_audio(delta: Any) -> bytes:
    """Decode one base64 audio delta, dropping a malformed one rather than failing the turn."""
    if not isinstance(delta, str) or not delta:
        return b""
    try:
        return base64.b64decode(delta, validate=True)
    except (ValueError, TypeError):
        logger.warning("dropped a malformed audio delta from the realtime session")
        return b""


def _tool_request(event: dict[str, Any]) -> dict[str, Any] | None:
    """Lift a tool call out of a vendor event, or None when it cannot be acted on."""
    call_id = event.get("call_id")
    name = event.get("name")
    if not isinstance(call_id, str) or not isinstance(name, str):
        return None
    raw_arguments = event.get("arguments")
    arguments: dict[str, Any] = {}
    if isinstance(raw_arguments, str) and raw_arguments:
        try:
            parsed = json.loads(raw_arguments)
        except json.JSONDecodeError:
            logger.warning("realtime session sent unparsable tool arguments")
            return None
        if isinstance(parsed, dict):
            arguments = parsed
    return {"call_id": call_id, "name": name, "arguments": arguments}


def _error_message(event: dict[str, Any]) -> str:
    """Extract a readable message from a vendor error event."""
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return message
    return "realtime session reported an error"


def _is_benign_cancel_race(event: dict[str, Any]) -> bool:
    """Whether an error event is the vendor saying there was nothing to cancel.

    Sent back when our own response.cancel loses a race against the vendor finishing
    that same response on its own a moment earlier -- expected, not a real failure,
    and safe to ignore: we already treat that response as discarded either way at both
    cancel_response() call sites, whether the vendor got to finish it or not.
    """
    return "no active response" in _error_message(event).lower()


def _parse_usage(event: dict[str, Any]) -> dict[str, Any] | None:
    """Flatten a response.done event's usage block, or None when it has none.

    The vendor only includes usage once response.status is "completed" -- a
    cancelled or failed response reports nothing here, which is not an error.
    """
    response = event.get("response")
    if not isinstance(response, dict):
        return None
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    input_details = usage.get("input_tokens_details")
    if not isinstance(input_details, dict):
        input_details = {}
    output_details = usage.get("output_tokens_details")
    if not isinstance(output_details, dict):
        output_details = {}
    return {
        "total_tokens": usage.get("total_tokens"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "input_text_tokens": input_details.get("text_tokens"),
        "input_audio_tokens": input_details.get("audio_tokens"),
        "output_text_tokens": output_details.get("text_tokens"),
        "output_audio_tokens": output_details.get("audio_tokens"),
    }


class QwenAudioSessionFactory:
    """Open one configured session per turn."""

    def __init__(
        self,
        config: QwenAudioConfig,
        *,
        connect: Any = None,
        open_timeout_seconds: float = 10.0,
    ) -> None:
        """Store the config plus the connect seam tests replace."""
        self._config = config
        self._connect = connect
        self._open_timeout_seconds = open_timeout_seconds

    async def open(
        self, instructions: str, tools: list[dict[str, Any]], voice_mode: str
    ) -> QwenAudioSession:
        """Connect, configure, and return a session ready for audio.
        Closes on failure: a socket the caller never receives is one nobody can close.
        """
        connect = self._connect or _default_connect
        started = time.perf_counter()
        status = "ok"
        session: QwenAudioSession | None = None
        try:
            async with ExternalCall("realtime", "open") as call:
                async with asyncio.timeout(self._open_timeout_seconds):
                    transport = await connect(self._config)
                    session = QwenAudioSession(transport, self._config, voice_mode)
                    try:
                        await session.configure(instructions, tools)
                    except BaseException:
                        await session.close()
                        raise
                call.mark_first_byte()
        except TimeoutError:
            status = "error"
            raise
        except Exception:
            status = "error"
            raise
        finally:
            REALTIME_CONNECTIONS.labels(status).inc()
            REALTIME_CONNECT_DURATION.labels(status).observe(time.perf_counter() - started)
        assert session is not None
        return session


async def _default_connect(config: QwenAudioConfig) -> Transport:
    """Open a real WebSocket to the vendor endpoint."""
    import websockets

    connection = await websockets.connect(
        config.url(), additional_headers=config.headers(), max_size=None
    )
    return connection
