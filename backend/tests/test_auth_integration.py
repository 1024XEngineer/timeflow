"""真实认证组件在 HTTP、数据库与 WebSocket 间的集成测试。"""

import threading
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, cast
from uuid import uuid4

import pytest
from auth_test_support import (
    OTHER_TEST_JWT_SECRET,
    build_test_token_service,
    encode_test_token,
)
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, delete, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from timeflow.business.calendar import (
    CreateScheduleCommand,
    ScheduleApplicationService,
    ScheduleKind,
    ScheduleType,
)
from timeflow.data.database import Base, build_session_factory
from timeflow.data.models import Account, Schedule
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.gateway.http import (
    AuthenticatedAccount,
    AuthenticatedAccountDependency,
)
from timeflow.gateway.websocket.ports import StreamContext
from timeflow.infrastructure.security import Argon2PasswordHasher, JwtAccessTokenService
from timeflow.infrastructure.security.access_token import JWT_ACCESS_TTL_SECONDS
from timeflow.main import create_app

USERNAME = "Alice"
PASSWORD = "correct-password"
DEVICE_ID = "device_001"


@dataclass(frozen=True, slots=True)
class _AccessResponse:
    """测试关心的账户访问响应。"""

    account_id: str
    access_token: str
    expires_in: int


class _CapturingAudioSink:
    """记录音频流携带的服务端可信会话。"""

    def __init__(self) -> None:
        self.streams: list[StreamContext] = []
        self.completed = threading.Event()

    async def consume(
        self,
        chunks: AsyncIterator[bytes],
        stream: StreamContext,
    ) -> None:
        """消费完整音频流并保留其上下文。"""
        self.streams.append(stream)
        async for _chunk in chunks:
            pass
        self.completed.set()


@dataclass(slots=True)
class _AppHarness:
    """集中持有每个测试独享的应用及真实适配器。"""

    application: FastAPI
    client: TestClient
    engine: Engine
    sessions: sessionmaker[Session]
    tokens: JwtAccessTokenService
    audio_sink: _CapturingAudioSink


def _install_protected_probe(application: FastAPI) -> None:
    """挂载只读取正式认证依赖的测试探针。"""
    dependency = cast(
        AuthenticatedAccountDependency,
        application.state.authenticated_account_dependency,
    )

    @application.get("/_test/protected")
    def protected(
        account: Annotated[AuthenticatedAccount, Depends(dependency)],
        account_id: str | None = None,
    ) -> dict[str, str | None]:
        """同时返回可信身份和客户端不可信查询值。"""
        return {
            "trusted_account_id": account.account_id,
            "supplied_account_id": account_id,
        }


@pytest.fixture
def app_harness() -> Iterator[_AppHarness]:
    """为每个场景构建共享连接的隔离 SQLite 应用。"""
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    sessions = build_session_factory(engine)
    tokens = build_test_token_service()
    audio_sink = _CapturingAudioSink()
    application = create_app(
        engine=engine,
        access_token_service=tokens,
        audio_sink=audio_sink,
    )
    _install_protected_probe(application)

    with TestClient(application) as client:
        yield _AppHarness(application, client, engine, sessions, tokens, audio_sink)

    engine.dispose()


def _access(
    client: TestClient,
    *,
    username: str = USERNAME,
    password: str = PASSWORD,
) -> _AccessResponse:
    """通过公开接口取得并校验成功响应。"""
    response = client.post(
        "/api/v1/auth/access",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"account_id", "access_token", "expires_in"}
    assert isinstance(body["account_id"], str)
    assert isinstance(body["access_token"], str)
    assert isinstance(body["expires_in"], int)
    return _AccessResponse(
        account_id=body["account_id"],
        access_token=body["access_token"],
        expires_in=body["expires_in"],
    )


def _hello(access_token: str) -> dict[str, object]:
    """构建契约规定的 WebSocket 首帧。"""
    return {
        "type": "session.hello",
        "request_id": "req_session_001",
        "payload": {
            "access_token": access_token,
            "device_id": DEVICE_ID,
            "app_version": "2.0.0",
            "timezone": "Asia/Shanghai",
        },
    }


def _unusable_token(token_kind: str) -> str:
    """生成覆盖不同 JWT 拒绝原因的真实测试输入。"""
    if token_kind == "malformed":
        return "not-a-jwt"
    if token_kind == "expired":
        return encode_test_token(issued_at=1)
    if token_kind == "wrong-signature":
        return encode_test_token(secret=OTHER_TEST_JWT_SECRET)
    if token_kind == "wrong-algorithm":
        return encode_test_token(algorithm="HS384")
    if token_kind == "wrong-issuer":
        return encode_test_token(claims={"iss": "other-api"})
    if token_kind == "wrong-audience":
        return encode_test_token(claims={"aud": "other-app"})
    if token_kind == "missing-claim":
        return encode_test_token(omitted_claims=("sub",))
    raise AssertionError(f"未知测试令牌类型：{token_kind}")


def test_http_creates_and_reuses_an_argon2_account(app_harness: _AppHarness) -> None:
    """首次访问创建账户，再次访问复用账户并验证 Argon2 哈希。"""
    first = _access(app_harness.client, username=f"  {USERNAME}  ")

    with app_harness.sessions() as session:
        account = session.scalar(select(Account).where(Account.username == USERNAME))

    assert account is not None
    assert account.id == first.account_id
    assert account.password_hash.startswith("$argon2id$")
    assert PASSWORD not in account.password_hash
    assert Argon2PasswordHasher().verify(PASSWORD, account.password_hash)
    assert first.expires_in == JWT_ACCESS_TTL_SECONDS
    assert app_harness.tokens.verify(first.access_token) == first.account_id

    second = _access(app_harness.client)

    assert second.account_id == first.account_id
    assert second.expires_in == JWT_ACCESS_TTL_SECONDS
    assert app_harness.tokens.verify(second.access_token) == first.account_id


def test_http_rejects_a_wrong_password_for_an_existing_account(
    app_harness: _AppHarness,
) -> None:
    """已有用户名不能使用错误密码换取令牌。"""
    created = _access(app_harness.client)

    response = app_harness.client.post(
        "/api/v1/auth/access",
        json={"username": USERNAME, "password": "different-password"},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": {
            "code": "AUTH_INVALID_CREDENTIALS",
            "message": "Invalid username or password",
        }
    }
    assert app_harness.tokens.verify(created.access_token) == created.account_id


def test_postgres_http_access_persists_account_and_jwt_opens_websocket(
    postgres_engine: Engine,
) -> None:
    """真实 PostgreSQL 中注册、登录，并以同一 JWT 建立可信 WebSocket 身份。"""
    username = f"auth-flow-{uuid4().hex}"
    tokens = build_test_token_service()
    audio_sink = _CapturingAudioSink()
    application = create_app(
        engine=postgres_engine,
        access_token_service=tokens,
        audio_sink=audio_sink,
    )

    try:
        with TestClient(application) as client:
            registered = _access(client, username=username)
            logged_in = _access(client, username=username)

            assert logged_in.account_id == registered.account_id
            assert tokens.verify(logged_in.access_token) == registered.account_id

            with client.websocket_connect(f"/ws?device_id={DEVICE_ID}") as websocket:
                websocket.send_json(_hello(logged_in.access_token))
                ready = websocket.receive_json()
                assert ready["type"] == "session.ready"
                assert ready["ok"] is True

        with Session(postgres_engine) as session:
            account = session.scalar(select(Account).where(Account.username == username))
        assert account is not None
        assert account.id == registered.account_id
        assert account.password_hash.startswith("$argon2id$")
        assert PASSWORD not in account.password_hash
    finally:
        with postgres_engine.begin() as connection:
            connection.execute(delete(Account).where(Account.username == username))


def test_postgres_jwt_returns_only_its_committed_schedule_snapshot(
    postgres_engine: Engine,
) -> None:
    """真实 JWT 只读取其账户经生产 UoW 提交的日程。"""
    suffix = uuid4().hex
    usernames = (f"snapshot-owner-{suffix}", f"snapshot-other-{suffix}")
    schedule_ids = (f"schedule_snapshot_{suffix}", f"schedule_other_{suffix}")
    tokens = build_test_token_service()
    application = create_app(
        engine=postgres_engine,
        access_token_service=tokens,
        audio_sink=_CapturingAudioSink(),
    )
    sessions = build_session_factory(postgres_engine)
    generated_ids = iter(schedule_ids)
    schedule_service = ScheduleApplicationService(
        lambda: SqlAlchemyScheduleUnitOfWork(sessions),
        id_factory=lambda: next(generated_ids),
    )

    try:
        with TestClient(application) as client:
            owner = _access(client, username=usernames[0])
            other = _access(client, username=usernames[1])
            command = CreateScheduleCommand(
                schedule_type=ScheduleType.TIME,
                schedule_kind=ScheduleKind.ONCE,
                title="Cloud schedule",
                timezone="Asia/Shanghai",
                start_time=datetime(2026, 8, 17, 1, 0, tzinfo=UTC),
            )
            schedule_service.create_schedule(account_id=owner.account_id, command=command)
            schedule_service.create_schedule(account_id=other.account_id, command=command)

            response = client.get(
                "/api/v1/schedule/snapshot",
                headers={"Authorization": f"Bearer {owner.access_token}"},
            )

        assert response.status_code == 200
        body = response.json()
        assert [schedule["id"] for schedule in body["schedules"]] == [schedule_ids[0]]
        assert {schedule["account_id"] for schedule in body["schedules"]} == {owner.account_id}
        assert body["occurrence_overrides"] == []
    finally:
        with postgres_engine.begin() as connection:
            account_ids = select(Account.id).where(Account.username.in_(usernames))
            connection.execute(delete(Schedule).where(Schedule.account_id.in_(account_ids)))
            connection.execute(delete(Account).where(Account.username.in_(usernames)))


def test_postgres_empty_account_returns_an_empty_schedule_snapshot(
    postgres_engine: Engine,
) -> None:
    """真实空账户通过生产 reader 得到两个空集合。"""
    username = f"snapshot-empty-{uuid4().hex}"
    tokens = build_test_token_service()
    application = create_app(
        engine=postgres_engine,
        access_token_service=tokens,
        audio_sink=_CapturingAudioSink(),
    )

    try:
        with TestClient(application) as client:
            access = _access(client, username=username)
            response = client.get(
                "/api/v1/schedule/snapshot",
                headers={"Authorization": f"Bearer {access.access_token}"},
            )

        assert response.status_code == 200
        assert response.json() == {"schedules": [], "occurrence_overrides": []}
    finally:
        with postgres_engine.begin() as connection:
            connection.execute(delete(Account).where(Account.username == username))


def test_one_http_jwt_establishes_trusted_http_and_websocket_accounts(
    app_harness: _AppHarness,
) -> None:
    """同一真实 JWT 在两条入口解析为相同且不可覆盖的账户。"""
    access = _access(app_harness.client)

    protected = app_harness.client.get(
        "/_test/protected?account_id=acc_attacker",
        headers={"Authorization": f"Bearer {access.access_token}"},
    )

    assert protected.status_code == 200
    assert protected.json() == {
        "trusted_account_id": access.account_id,
        "supplied_account_id": "acc_attacker",
    }

    path = f"/ws?device_id={DEVICE_ID}&account_id=acc_attacker"
    with app_harness.client.websocket_connect(path) as websocket:
        websocket.send_json(_hello(access.access_token))
        ready = websocket.receive_json()
        assert ready["type"] == "session.ready"
        websocket.send_json(
            {
                "type": "voice.stream.start",
                "request_id": "req_stream_001",
                "payload": {
                    "conversation_id": None,
                    "audio_format": "pcm_s16le",
                    "sample_rate_hz": 16000,
                    "channels": 1,
                },
            }
        )
        started = websocket.receive_json()
        websocket.send_bytes(b"\x01\x02")
        websocket.send_json(
            {
                "type": "voice.stream.end",
                "payload": {"stream_id": started["payload"]["stream_id"]},
            }
        )
        assert app_harness.audio_sink.completed.wait(timeout=2)

    assert len(app_harness.audio_sink.streams) == 1
    session = app_harness.audio_sink.streams[0].session
    assert session.account_id == access.account_id
    assert session.account_id != "acc_attacker"


@pytest.mark.parametrize(
    "token_kind",
    [
        "malformed",
        "expired",
        "wrong-signature",
        "wrong-algorithm",
        "wrong-issuer",
        "wrong-audience",
        "missing-claim",
    ],
)
def test_http_and_websocket_reject_the_same_unusable_token(
    app_harness: _AppHarness,
    token_kind: str,
) -> None:
    """所有 v1 拒绝原因在 HTTP 和 WebSocket 中保持相同结果。"""
    token = _unusable_token(token_kind)

    protected = app_harness.client.get(
        "/_test/protected",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert protected.status_code == 401
    assert protected.headers["content-type"] == "application/json"
    assert protected.json() == {
        "error": {"code": "AUTH_INVALID_TOKEN", "message": "Invalid access token"}
    }

    with app_harness.client.websocket_connect(f"/ws?device_id={DEVICE_ID}") as websocket:
        websocket.send_json(_hello(token))
        rejected = websocket.receive_json()
        closed = websocket.receive()

    assert rejected == {
        "type": "session.error",
        "request_id": "req_session_001",
        "ok": False,
        "error": {
            "code": "UNAUTHENTICATED",
            "message": "Access token is not valid",
            "retryable": False,
        },
    }
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_missing_bearer_uses_the_formal_application_dependency(
    app_harness: _AppHarness,
) -> None:
    """正式应用装配的认证依赖对缺失凭据返回稳定错误。"""
    response = app_harness.client.get("/_test/protected")

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {
        "error": {"code": "AUTH_REQUIRED", "message": "Authentication required"}
    }
