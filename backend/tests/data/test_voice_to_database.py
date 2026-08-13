"""One spoken turn, from the socket to a committed row and back out."""

import json
import os
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy as sa
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from timeflow.business.calendar.service import ScheduleApplicationService
from timeflow.data.database import build_session_factory
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.endpoint import (
    UnauthenticatedConnectionLimiter,
    run_websocket_session,
)
from timeflow.gateway.websocket.handlers.agent_audio import AgentAudioSink
from timeflow.gateway.websocket.handlers.agent_result import WebSocketResultSink
from timeflow.gateway.websocket.handlers.message_ack import handle_message_ack
from timeflow.gateway.websocket.handlers.session import SessionHandshake
from timeflow.gateway.websocket.handlers.voice_stream import VoiceStreamHandlers
from timeflow.gateway.websocket.router import MessageRouter
from timeflow.intelligence.realtime.agent import RealtimeAgent
from timeflow.intelligence.realtime.instructions import build_instructions
from timeflow.intelligence.realtime.schedule_tools import SCHEDULE_CREATE, ToolBox

HELLO: dict[str, Any] = {
    "type": "session.hello",
    "request_id": "req_001",
    "payload": {"access_token": "token-abc", "device_id": "device_001"},
}
START: dict[str, Any] = {
    "type": "voice.stream.start",
    "request_id": "req_002",
    "payload": {
        "conversation_id": None,
        "audio_format": "pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
    },
}
END: dict[str, Any] = {"type": "voice.stream.end", "request_id": "req_002", "payload": {}}

FAKE_ACCOUNT_ID = "acc_fake_001"
_REJECTED_TOKENS = frozenset({"bad", "invalid", "expired"})


class FakeTokenVerifier:
    """仅供本文件旧数据流集成测试使用的同步令牌替身。"""

    def __init__(self, account_id: str = FAKE_ACCOUNT_ID) -> None:
        self._account_id = account_id

    def verify(self, access_token: str) -> str | None:
        """返回测试账户身份，或拒绝明确标记为无效的令牌。"""
        if not access_token or access_token in _REJECTED_TOKENS:
            return None
        return self._account_id


class ToolCallingSession:
    """A model that hears a request, calls one tool, then says what it did."""

    def __init__(self, tool: str, arguments: dict[str, Any]) -> None:
        """Store the single tool call this session will make."""
        self._tool = tool
        self._arguments = arguments
        self.tool_results: list[tuple[str, str]] = []
        self.closed = False

    async def send_audio(self, chunk: bytes) -> None:
        """Accept the user's audio without inspecting it."""

    async def finish_input(self) -> None:
        """Accept the end of the user's turn."""

    async def send_tool_result(self, call_id: str, output: str) -> None:
        """Record what the tool answered, which is what the model would read."""
        self.tool_results.append((call_id, output))

    async def close(self) -> None:
        """Record release."""
        self.closed = True

    async def pump(self, observer: Any) -> None:
        """Hear the user, call the tool, then speak a confirmation."""
        await observer.heard("明天下午三点开会")
        await observer.tool_requested("call_001", self._tool, dict(self._arguments))
        await observer.spoke("好，记下了")
        await observer.audio(b"pcm-reply")


class OneSessionFactory:
    """Hand out the one scripted session, recording the tools registered on it."""

    def __init__(self, session: ToolCallingSession) -> None:
        """Store the session to hand out."""
        self._session = session
        self.tools: list[dict[str, Any]] = []

    async def open(
        self, instructions: str, tools: list[dict[str, Any]], voice_mode: str
    ) -> ToolCallingSession:
        """Record the registered tools and return the scripted session."""
        self.tools = tools
        return self._session


async def _one_chunk() -> AsyncIterator[bytes]:
    """A turn's worth of audio."""
    yield b"pcm-user"


@pytest.fixture(scope="module")
def engine() -> Iterator[Engine]:
    """Connect only when an explicit disposable integration database is supplied."""
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")
    built = sa.create_engine(database_url)
    try:
        yield built
    finally:
        built.dispose()


@pytest.fixture
def account(engine: Engine) -> Iterator[str]:
    """Give the stand-in verifier's account a row, since schedules reference one."""
    factory = build_session_factory(engine)
    now = datetime.now(UTC)
    with factory() as session:
        session.execute(
            sa.text(
                "INSERT INTO accounts (id, username, password_hash, created_at, updated_at) "
                "VALUES (:id, :username, 'test-hash', :now, :now) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"id": FAKE_ACCOUNT_ID, "username": f"{FAKE_ACCOUNT_ID}-user", "now": now},
        )
        session.commit()
    try:
        yield FAKE_ACCOUNT_ID
    finally:
        with factory() as session:
            session.execute(
                sa.text("DELETE FROM schedules WHERE account_id = :id"), {"id": FAKE_ACCOUNT_ID}
            )
            session.execute(sa.text("DELETE FROM accounts WHERE id = :id"), {"id": FAKE_ACCOUNT_ID})
            session.commit()


def _build_app(engine: Engine, session: ToolCallingSession) -> tuple[FastAPI, OneSessionFactory]:
    """Wire the real transport, agent, tools, and database behind one /ws route."""
    application = FastAPI()
    connections = ConnectionManager()
    factory = OneSessionFactory(session)
    session_factory = build_session_factory(engine)

    schedule_service = ScheduleApplicationService(
        lambda: SqlAlchemyScheduleUnitOfWork(session_factory)
    )

    def bind_account(account_id: str, timezone: str) -> ToolBox:
        return ToolBox(account_id, schedule_service, timezone)

    agent = RealtimeAgent(
        factory,
        WebSocketResultSink(connections),
        tools_factory=bind_account,
        instructions=build_instructions,
    )
    voice_streams = VoiceStreamHandlers(
        AgentAudioSink(agent), max_audio_duration_ms=60_000, queue_max_chunks=64
    )
    router = MessageRouter()
    router.register("voice.stream.start", voice_streams.handle_start)
    router.register("voice.stream.end", voice_streams.handle_end)
    router.register("message.ack", handle_message_ack)

    @application.websocket("/ws")
    async def endpoint(websocket: WebSocket) -> None:
        """Serve one session the way the composition root does."""
        await run_websocket_session(
            websocket,
            SessionHandshake(FakeTokenVerifier()),
            router,
            connections,
            UnauthenticatedConnectionLimiter(8),
            handshake_timeout_seconds=5,
            binary_handler=voice_streams.handle_binary,
            disconnect_handler=voice_streams.handle_disconnect,
        )

    return application, factory


def _drain(client_socket: Any, wanted: str, limit: int = 12) -> dict[str, Any]:
    """Read frames until the wanted type arrives, skipping binary audio."""
    for _ in range(limit):
        frame = client_socket.receive()
        if frame.get("type") == "websocket.send" and frame.get("text") is not None:
            message: dict[str, Any] = json.loads(frame["text"])
            if message["type"] == wanted:
                return message
    raise AssertionError(f"never saw {wanted}")


def test_a_spoken_turn_commits_a_schedule_and_reports_it_to_the_client(
    engine: Engine, account: str
) -> None:
    """One turn: audio in, a tool call, a committed row, and a result on the wire."""
    session = ToolCallingSession(
        SCHEDULE_CREATE,
        {
            "schedule_type": "time",
            "schedule_kind": "once",
            "title": "明天下午三点开会",
            "start_time": "2026-09-08T15:00:00",
        },
    )
    application, factory = _build_app(engine, session)
    account_id: str | None = None

    with TestClient(application) as client, client.websocket_connect("/ws") as socket:
        socket.send_json(HELLO)
        ready = socket.receive_json()
        assert ready["type"] == "session.ready"
        socket.send_json(START)
        started = socket.receive_json()
        assert started["type"] == "voice.stream.started"
        socket.send_bytes(b"pcm-user")
        socket.send_json(END)

        transcript = _drain(socket, "voice.asr.completed")
        assert transcript["payload"]["transcript"] == "明天下午三点开会"
        result = _drain(socket, "voice.command.result")

    assert result["payload"]["operation"] == "create_schedule"
    assert result["payload"]["status"] == "applied"
    schedule_id = result["payload"]["schedule"]["schedule"]["id"]

    # The registered tools are the ones the model was actually offered.
    assert SCHEDULE_CREATE in {tool["function"]["name"] for tool in factory.tools}
    # The model was handed the tool's answer, so it can speak from what was committed.
    assert session.tool_results and session.tool_results[0][0] == "call_001"

    with build_session_factory(engine)() as check:
        row = check.execute(
            sa.text(
                "SELECT account_id, title, status, revision, start_time "
                "FROM schedules WHERE id = :id"
            ),
            {"id": schedule_id},
        ).one()
        account_id = row.account_id
        assert account_id == account
        assert row.title == "明天下午三点开会"
        assert row.status == "active"
        assert row.revision == 1
        # Stored as the instant 15:00 Asia/Shanghai names, which is 07:00 UTC.
        assert row.start_time.astimezone(UTC).hour == 7
        check.execute(sa.text("DELETE FROM schedules WHERE id = :id"), {"id": schedule_id})
        check.commit()

    assert account_id is not None
