#!/usr/bin/env python3
"""End-to-end smoke test for server-initiated reminder audio delivery."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from time import perf_counter
from typing import Any, cast

import uvicorn
from websockets.asyncio.client import ClientConnection, connect

from timeflow.data.reminder_audio_storage import FileReminderAudioStorage
from timeflow.infrastructure.settings import Settings
from timeflow.infrastructure.websocket.reminder_audio import ReminderAudioSender


def parse_args() -> argparse.Namespace:
    """Parse the target schedule and temporary server address."""
    parser = argparse.ArgumentParser(
        description=(
            "Start a temporary TimeFlow server, receive one reminder audio stream, "
            "and compare it with the stored audio file"
        )
    )
    parser.add_argument(
        "--schedule-id",
        required=True,
        help="Schedule ID whose generated reminder audio should be delivered",
    )
    parser.add_argument("--device-id", default="reminder_audio_smoke_test")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8002)
    parser.add_argument("--timeout", type=float, default=10.0)
    return parser.parse_args()


async def _receive_json(websocket: ClientConnection, timeout: float) -> dict[str, Any]:
    frame = await asyncio.wait_for(websocket.recv(), timeout=timeout)
    if not isinstance(frame, str):
        raise RuntimeError("expected a JSON text frame, received binary data")
    try:
        message = json.loads(frame)
    except json.JSONDecodeError as exc:
        raise RuntimeError("server returned malformed JSON") from exc
    if not isinstance(message, dict):
        raise RuntimeError("server JSON frame must be an object")
    return cast(dict[str, Any], message)


def _require_message_type(message: dict[str, Any], expected: str) -> None:
    actual = message.get("type")
    if actual != expected:
        raise RuntimeError(f"expected {expected}, received {actual}: {message}")


async def _wait_until_started(
    server: uvicorn.Server,
    server_task: asyncio.Task[None],
    timeout: float,
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not server.started:
        if server_task.done():
            try:
                await server_task
            except BaseException as exc:
                raise RuntimeError(
                    "temporary server stopped before accepting connections"
                ) from exc
            raise RuntimeError("temporary server stopped before accepting connections")
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("temporary server startup timed out")
        await asyncio.sleep(0.05)


async def _receive_audio(
    websocket: ClientConnection,
    *,
    schedule_id: str,
    timeout: float,
) -> tuple[str, str, bytes]:
    control = await _receive_json(websocket, timeout)
    _require_message_type(control, "reminder.control")
    if control.get("schedule_id") != schedule_id:
        raise RuntimeError(f"reminder.control has an unexpected schedule_id: {control}")

    start = await _receive_json(websocket, timeout)
    _require_message_type(start, "reminder.audio.start")
    if start.get("schedule_id") != schedule_id:
        raise RuntimeError(f"reminder.audio.start has an unexpected schedule_id: {start}")

    stream_id = start.get("stream_id")
    audio_format = start.get("audio_format")
    if not isinstance(stream_id, str) or not stream_id:
        raise RuntimeError("reminder.audio.start does not contain a valid stream_id")
    if not isinstance(audio_format, str) or not audio_format:
        raise RuntimeError("reminder.audio.start does not contain a valid audio_format")

    chunks: list[bytes] = []
    while True:
        frame = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        if isinstance(frame, bytes):
            chunks.append(frame)
            continue

        try:
            end = json.loads(frame)
        except json.JSONDecodeError as exc:
            raise RuntimeError("server returned malformed JSON after audio data") from exc
        if not isinstance(end, dict):
            raise RuntimeError("audio end frame must be a JSON object")
        _require_message_type(end, "reminder.audio.end")
        if end.get("schedule_id") != schedule_id or end.get("stream_id") != stream_id:
            raise RuntimeError(f"reminder.audio.end does not match the stream: {end}")
        break

    if not chunks:
        raise RuntimeError("server did not send any binary audio frame")
    return stream_id, audio_format, b"".join(chunks)


async def run(args: argparse.Namespace) -> None:
    """Run a temporary server and verify one complete delivery."""
    backend_root = Path(__file__).resolve().parents[1]
    settings = Settings.from_environment(backend_root / ".env")
    os.environ["TIMEFLOW_REMINDER_AUDIO_DIR"] = str(settings.reminder_audio_dir)

    storage = FileReminderAudioStorage(settings.reminder_audio_dir)
    expected_audio = await storage.read(args.schedule_id)
    if expected_audio is None:
        raise SystemExit(
            f"No reminder audio found for {args.schedule_id!r} in "
            f"{settings.reminder_audio_dir}"
        )

    # Import after loading backend/.env so the application uses the same configuration.
    from timeflow.main import app

    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    try:
        await _wait_until_started(server, server_task, args.timeout)
        uri = f"ws://{args.host}:{args.port}/ws?device_id={args.device_id}"
        started_at = perf_counter()

        async with connect(uri, max_size=None) as websocket:
            await websocket.send(
                json.dumps(
                    {
                        "type": "session.hello",
                        "device_id": args.device_id,
                        "app_version": "reminder-audio-smoke-1.0",
                    }
                )
            )
            ready = await _receive_json(websocket, args.timeout)
            _require_message_type(ready, "session.ready")
            await asyncio.sleep(0)

            sender = cast(ReminderAudioSender, app.state.reminder_audio_sender)
            delivery_task = asyncio.create_task(
                sender.send_reminder(
                    args.device_id,
                    args.schedule_id,
                    reason="smoke_test",
                )
            )
            try:
                stream_id, audio_format, received_data = await _receive_audio(
                    websocket,
                    schedule_id=args.schedule_id,
                    timeout=args.timeout,
                )
                delivered = await asyncio.wait_for(delivery_task, timeout=args.timeout)
            finally:
                if not delivery_task.done():
                    delivery_task.cancel()
                    await asyncio.gather(delivery_task, return_exceptions=True)
            if not delivered:
                raise RuntimeError("ReminderAudioSender reported that delivery failed")
            if received_data != expected_audio.data:
                raise RuntimeError(
                    "received audio differs from the stored reminder audio: "
                    f"expected {len(expected_audio.data)} bytes, got {len(received_data)} bytes"
                )
            if audio_format != expected_audio.audio_format:
                raise RuntimeError(
                    f"audio format mismatch: expected {expected_audio.audio_format}, "
                    f"got {audio_format}"
                )

            await websocket.send(
                json.dumps(
                    {
                        "type": "reminder.audio.ack",
                        "schedule_id": args.schedule_id,
                        "stream_id": stream_id,
                        "ok": True,
                    }
                )
            )
            await asyncio.sleep(0.05)

        elapsed = perf_counter() - started_at
        print("Reminder audio delivery passed")
        print(f"WebSocket: {uri}")
        print(f"Schedule ID: {args.schedule_id}")
        print(f"Stream ID: {stream_id}")
        print(f"Audio format: {audio_format}")
        print(f"Audio size: {len(received_data)} bytes")
        print(f"Elapsed: {elapsed:.3f}s")
    finally:
        server.should_exit = True
        if not server_task.done():
            await server_task
        else:
            server_task.exception()


async def main() -> None:
    """Run the command-line smoke test."""
    await run(parse_args())


if __name__ == "__main__":
    asyncio.run(main())
