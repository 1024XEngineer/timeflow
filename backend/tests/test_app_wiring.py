"""应用组合根的安全装配测试。"""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from unittest import mock

import pytest
from auth_test_support import (
    TEST_JWT_ENVIRONMENT,
    TEST_JWT_SECRET,
    build_test_token_service,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from observability_support import metric_value
from sqlalchemy import create_engine, event

from timeflow.business.auth import AuthAccessResult
from timeflow.business.calendar import (
    AccountScheduleSnapshot,
    CreateScheduleCommand,
    ReminderDispositionResult,
    ReminderDispositionState,
    ScheduleApplicationService,
    ScheduleKind,
    ScheduleType,
)
from timeflow.gateway.websocket.ports import StreamContext
from timeflow.infrastructure.settings import get_settings
from timeflow.main import create_app


class _Sink:
    """装配测试不会使用的空音频接收器。"""

    async def consume(
        self,
        chunks: AsyncIterator[bytes],
        stream: StreamContext,
    ) -> None:
        """消费输入但不产生外部副作用。"""
        async for _chunk in chunks:
            pass


class _UnusedAuthAccess:
    """隔离数据库装配，使测试只关注安全组件。"""

    def access(self, username: str, password: str) -> AuthAccessResult:
        """这些装配测试不应调用账户访问用例。"""
        raise AssertionError(f"unexpected auth access for {username!r} and password")


class _UnusedScheduleSnapshotReader:
    """隔离数据库装配，使无关测试不会读取日程快照。"""

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot:
        """这些装配测试不应读取账户日程。"""
        raise AssertionError(f"unexpected schedule snapshot read for {account_id!r}")


class _CapturingScheduleSnapshotReader:
    """返回空快照并记录路由传入的可信账户。"""

    def __init__(self) -> None:
        self.account_ids: list[str] = []

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot:
        """记录读取目标并返回完整的空快照。"""
        self.account_ids.append(account_id)
        return AccountScheduleSnapshot((), ())


class _UnusedReminderConfirmer:
    """隔离数据库装配，使无关测试不会确认提醒。"""

    def confirm(self, *, account_id: str, schedule_id: str) -> ReminderDispositionResult:
        """这些装配测试不应确认提醒。"""
        raise AssertionError(f"unexpected reminder confirmation for {account_id!r}/{schedule_id!r}")


class _ReminderConfirmer:
    """Record reminder confirmations routed through the composition root."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def confirm(self, *, account_id: str, schedule_id: str) -> ReminderDispositionResult:
        self.calls.append((account_id, schedule_id))
        return ReminderDispositionResult(
            schedule_id=schedule_id,
            disposition_state=ReminderDispositionState.CONFIRMED,
            updated_at=datetime(2026, 8, 17, 3, 30, tzinfo=UTC),
        )


class _FakeAsyncClient:
    """记录 aclose() 是否被调用，不真的打开网络连接。"""

    def __init__(self, *, timeout: float) -> None:
        self.timeout = timeout
        self.closed = False

    async def aclose(self) -> None:
        """记录关闭。"""
        self.closed = True


def _tencent_environment() -> dict[str, str]:
    """腾讯地图凭据就绪时的最小环境变量集合。"""
    return {
        "TIMEFLOW_TENCENT_MAP_KEY": "key-for-test",
        "TIMEFLOW_TENCENT_MAP_BASE_URL": "https://apis.map.qq.com",
    }


def _composed_environment() -> dict[str, str]:
    """模式 2 组合式 ASR/LLM/TTS 凭据就绪时的最小环境变量集合。"""
    return {
        "TIMEFLOW_ALIYUN_ASR_WS_URL": "wss://asr.example.test",
        "TIMEFLOW_ALIYUN_ASR_API_KEY": "asr-key",
        "TIMEFLOW_OPENAI_BASE_URL": "https://llm.example.test/v1",
        "TIMEFLOW_OPENAI_API_KEY": "llm-key",
        "TIMEFLOW_ALIYUN_TTS_WS_URL": "wss://tts.example.test",
        "TIMEFLOW_ALIYUN_TTS_API_KEY": "tts-key",
    }


def _build_with_environment(
    environment: str,
    *,
    jwt_secret: str = TEST_JWT_SECRET,
    cors_allowed_origins: str = "",
    audio_configured: bool = False,
    voice_agent_mode: str = "1",
    **injected: Any,
) -> FastAPI:
    """固定外部环境后构建应用，避免本机配置改变断言含义。"""
    credentials = (
        {
            "TIMEFLOW_ALIYUN_AUDIO_API_KEY": "key-for-test",
            "TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID": "ws-for-test",
        }
        if audio_configured
        else {
            "TIMEFLOW_ALIYUN_AUDIO_API_KEY": "",
            "TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID": "",
        }
    )
    environment_values = {
        **TEST_JWT_ENVIRONMENT,
        "TIMEFLOW_ENVIRONMENT": environment,
        "TIMEFLOW_JWT_SECRET": jwt_secret,
        "TIMEFLOW_CORS_ALLOWED_ORIGINS": cors_allowed_origins,
        "TIMEFLOW_VOICE_AGENT_MODE": voice_agent_mode,
        **credentials,
    }
    get_settings.cache_clear()
    try:
        with mock.patch.dict(os.environ, environment_values, clear=False):
            auth_access = injected.pop("auth_access", _UnusedAuthAccess())
            injected.setdefault("schedule_snapshot_reader", _UnusedScheduleSnapshotReader())
            injected.setdefault(
                "reminder_disposition_confirmer",
                _UnusedReminderConfirmer(),
            )
            return create_app(auth_access=auth_access, **injected)
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize("jwt_secret", ["", "too-short"])
def test_build_rejects_an_empty_or_weak_default_jwt_secret(jwt_secret: str) -> None:
    """空或弱密钥不能构建 HTTP 与 WebSocket 共用的 JWT 服务。"""
    with pytest.raises(ValueError, match="JWT secret must be at least 32 UTF-8 bytes"):
        _build_with_environment(
            "development",
            jwt_secret=jwt_secret,
            audio_sink=_Sink(),
        )


def test_injected_token_service_is_shared_by_http_and_websocket() -> None:
    """显式注入的真实令牌服务同时供 HTTP 与 WebSocket 使用。"""
    tokens = build_test_token_service()
    issued = tokens.issue("acc_shared")
    application = _build_with_environment(
        "development",
        jwt_secret="",
        access_token_service=tokens,
        audio_sink=_Sink(),
    )

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "payload": {
                        "access_token": issued.access_token,
                        "device_id": "device_001",
                    },
                }
            )
            assert websocket.receive_json()["type"] == "session.ready"

    dependency = application.state.authenticated_account_dependency
    assert dependency(f"Bearer {issued.access_token}").account_id == "acc_shared"


def test_composition_root_counts_live_sessions_and_ui_hangup() -> None:
    """Authenticated /ws sessions occupy waiting_user and hang up as ui_hangup."""
    tokens = build_test_token_service()
    issued = tokens.issue("acc_occupancy")
    application = _build_with_environment(
        "development",
        jwt_secret="",
        access_token_service=tokens,
        audio_sink=_Sink(),
    )
    occupancy = {
        "stage": "waiting_user",
        "voice_mode": "push_to_talk",
        "agent_mode": "realtime",
    }
    hangup = {
        "reason": "ui_hangup",
        "voice_mode": "push_to_talk",
        "agent_mode": "realtime",
    }
    waiting_before = metric_value("timeflow_voice_sessions", occupancy)
    hangup_before = metric_value("timeflow_voice_session_ends_total", hangup)

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "payload": {
                        "access_token": issued.access_token,
                        "device_id": "device_001",
                    },
                }
            )
            assert websocket.receive_json()["type"] == "session.ready"
            assert metric_value("timeflow_voice_sessions", occupancy) == waiting_before + 1

    assert metric_value("timeflow_voice_sessions", occupancy) == waiting_before
    assert metric_value("timeflow_voice_session_ends_total", hangup) == hangup_before + 1


def test_failed_handshake_does_not_occupy_or_end_a_voice_session() -> None:
    """Auth failure closes the socket without touching occupancy gauges."""
    application = _build_with_environment("development", audio_sink=_Sink())
    occupancy = {
        "stage": "waiting_user",
        "voice_mode": "push_to_talk",
        "agent_mode": "realtime",
    }
    hangup = {
        "reason": "ui_hangup",
        "voice_mode": "push_to_talk",
        "agent_mode": "realtime",
    }
    waiting_before = metric_value("timeflow_voice_sessions", occupancy)
    hangup_before = metric_value("timeflow_voice_session_ends_total", hangup)

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "payload": {
                        "access_token": "arbitrary-non-jwt-token",
                        "device_id": "device_001",
                    },
                }
            )
            assert websocket.receive_json()["error"]["code"] == "UNAUTHENTICATED"

    assert metric_value("timeflow_voice_sessions", occupancy) == waiting_before
    assert metric_value("timeflow_voice_session_ends_total", hangup) == hangup_before


def test_schedule_snapshot_route_uses_the_shared_authenticated_account() -> None:
    """快照路由复用正式认证依赖，只把令牌中的可信账户交给 reader。"""
    tokens = build_test_token_service()
    issued = tokens.issue("acc_snapshot")
    reader = _CapturingScheduleSnapshotReader()
    application = _build_with_environment(
        "development",
        jwt_secret="",
        access_token_service=tokens,
        audio_sink=_Sink(),
        schedule_snapshot_reader=reader,
    )

    with TestClient(application) as client:
        response = client.get(
            "/api/v1/schedule/snapshot",
            headers={"Authorization": f"Bearer {issued.access_token}"},
        )

    assert response.status_code == 200
    assert response.json() == {"schedules": [], "occurrence_overrides": []}
    assert reader.account_ids == ["acc_snapshot"]
    dependency = application.state.authenticated_account_dependency
    assert dependency(f"Bearer {issued.access_token}").account_id == "acc_snapshot"


def test_composition_root_exposes_authenticated_reminder_state_sync() -> None:
    """The production app routes trusted JWT identity into the reminder use case."""
    tokens = build_test_token_service()
    issued = tokens.issue("acc_reminder")
    confirmer = _ReminderConfirmer()
    application = _build_with_environment(
        "development",
        jwt_secret="",
        access_token_service=tokens,
        audio_sink=_Sink(),
        reminder_disposition_confirmer=confirmer,
    )

    with TestClient(application) as client:
        response = client.put(
            "/api/v1/schedule/reminder-state",
            headers={"Authorization": f"Bearer {issued.access_token}"},
            json={
                "schedule_id": "schedule-001",
                "disposition_state": "confirmed",
            },
        )

    assert response.status_code == 200
    assert confirmer.calls == [("acc_reminder", "schedule-001")]


def test_configured_cors_origin_allows_reminder_state_put() -> None:
    """Browser clients can preflight the protected reminder-state endpoint."""
    application = _build_with_environment(
        "development",
        audio_sink=_Sink(),
        cors_allowed_origins="http://localhost:8081",
        reminder_disposition_confirmer=_ReminderConfirmer(),
    )

    with TestClient(application) as client:
        response = client.options(
            "/api/v1/schedule/reminder-state",
            headers={
                "Access-Control-Request-Headers": "authorization,content-type",
                "Access-Control-Request-Method": "PUT",
                "Origin": "http://localhost:8081",
            },
        )

    assert response.status_code == 200
    assert "PUT" in response.headers["access-control-allow-methods"]


def test_building_in_development_still_works_without_a_real_model() -> None:
    """开发环境没有外部模型时仍可使用显式的测试音频接收器。"""
    assert _build_with_environment("development", audio_sink=_Sink()) is not None


def test_configured_cors_origin_allows_expo_web_authentication() -> None:
    """浏览器预检只允许显式配置的 Expo Web 来源。"""
    application = _build_with_environment(
        "development",
        audio_sink=_Sink(),
        cors_allowed_origins="http://localhost:8081",
    )

    with TestClient(application) as client:
        allowed = client.options(
            "/api/v1/auth/access",
            headers={
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Method": "POST",
                "Origin": "http://localhost:8081",
            },
        )
        rejected = client.options(
            "/api/v1/auth/access",
            headers={
                "Access-Control-Request-Method": "POST",
                "Origin": "https://unconfigured.example.com",
            },
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:8081"
    assert "access-control-allow-origin" not in rejected.headers


def test_production_without_a_real_audio_sink_fails_closed() -> None:
    """生产环境缺少实时模型配置时拒绝空音频实现。"""
    with pytest.raises(RuntimeError, match="development-only"):
        _build_with_environment("production")


def test_production_builds_with_an_injected_audio_sink() -> None:
    """生产环境显式注入音频接收器后可完成装配。"""
    application = _build_with_environment("production", audio_sink=_Sink())

    assert application is not None


def test_production_websocket_rejects_a_non_jwt_token() -> None:
    """生产 WebSocket 只接受共享真实 JWT 服务签发的令牌。"""
    application = _build_with_environment("production", audio_sink=_Sink())

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "request_id": "req_production_auth",
                    "payload": {
                        "access_token": "arbitrary-non-jwt-token",
                        "device_id": "device_001",
                    },
                }
            )
            rejected = websocket.receive_json()
            closed = websocket.receive()

    assert rejected["error"]["code"] == "UNAUTHENTICATED"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_configured_realtime_model_lets_production_build() -> None:
    """实时模型凭据完整时无需手工注入音频接收器。"""
    application = _build_with_environment("production", audio_configured=True)

    assert application is not None


def test_missing_category_llm_configuration_logs_fallback_without_blocking_startup(
    caplog: pytest.LogCaptureFixture,
) -> None:
    missing_configuration = {
        "TIMEFLOW_OPENAI_BASE_URL": "",
        "TIMEFLOW_OPENAI_API_KEY": "",
        "TIMEFLOW_OPENAI_MODEL": "",
    }

    with mock.patch.dict(os.environ, missing_configuration, clear=False):
        application = _build_with_environment("production", audio_configured=True)

    assert application is not None
    assert (
        "schedule category classification is not configured; leaving category null" in caplog.text
    )
    assert "key-for-test" not in caplog.text


def test_missing_category_llm_configuration_skips_background_task_submission() -> None:
    captured: dict[str, Any] = {}

    class _Repository:
        def __init__(self) -> None:
            self.snapshot = None

        def add_schedule(self, snapshot: Any) -> Any:
            self.snapshot = snapshot
            return snapshot

    class _UnitOfWork:
        def __init__(self, repository: _Repository) -> None:
            self.schedules = repository

        def __enter__(self) -> "_UnitOfWork":
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def commit(self) -> None:
            return None

    repository = _Repository()

    def capture_service(*args: Any, **kwargs: Any) -> ScheduleApplicationService:
        from timeflow.business.calendar.service import ScheduleApplicationService as RealService

        service = RealService(*args, **kwargs)
        captured["service"] = service
        return service

    with (
        mock.patch("timeflow.main.ScheduleApplicationService", side_effect=capture_service),
        mock.patch.dict(
            os.environ,
            {
                "TIMEFLOW_OPENAI_BASE_URL": "",
                "TIMEFLOW_OPENAI_API_KEY": "",
                "TIMEFLOW_OPENAI_MODEL": "",
            },
            clear=False,
        ),
    ):
        _build_with_environment("production", audio_configured=True)

    service = captured["service"]
    assert service._category_classifier is None
    service._unit_of_work_factory = lambda: _UnitOfWork(repository)
    service._category_task_submitter = lambda _task: pytest.fail(
        "category task must not be submitted without OpenAI configuration"
    )

    created = service.create_schedule(
        account_id="account-a",
        command=CreateScheduleCommand(
            schedule_type=ScheduleType.TIME,
            schedule_kind=ScheduleKind.ONCE,
            title="未配置分类能力",
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 19, 7, tzinfo=UTC),
        ),
    ).schedules[0]

    assert created.category is None
    assert repository.snapshot is not None
    assert repository.snapshot.category is None


def test_configured_category_llm_is_injected_into_the_schedule_service() -> None:
    captured: dict[str, Any] = {}
    classifier = mock.Mock()

    def capture_service(*args: Any, **kwargs: Any) -> ScheduleApplicationService:
        from timeflow.business.calendar.service import ScheduleApplicationService as RealService

        captured.update(kwargs)
        return RealService(*args, **kwargs)

    with (
        mock.patch("timeflow.main.ScheduleApplicationService", side_effect=capture_service),
        mock.patch(
            "timeflow.main.LlmScheduleCategoryClassifier",
            return_value=classifier,
        ) as classifier_factory,
        mock.patch("timeflow.main.OpenAICompatibleJsonLlm") as llm_factory,
        mock.patch.dict(
            os.environ,
            {
                "TIMEFLOW_OPENAI_BASE_URL": "https://llm.example.test/v1",
                "TIMEFLOW_OPENAI_API_KEY": "category-key-for-test",
                "TIMEFLOW_OPENAI_MODEL": "category-model-for-test",
            },
            clear=False,
        ),
    ):
        _build_with_environment("production", audio_configured=True)

    assert captured["category_classifier"] is classifier
    llm_factory.assert_called_once()
    classifier_factory.assert_called_once_with(llm_factory.return_value)


def test_voice_agent_mode_two_fails_closed_without_composed_credentials() -> None:
    """模式 2 缺少组合式 ASR/LLM/TTS 凭据时快速失败，而不是静默降级。"""
    missing = {
        "TIMEFLOW_ALIYUN_ASR_WS_URL": "",
        "TIMEFLOW_ALIYUN_ASR_API_KEY": "",
        "TIMEFLOW_OPENAI_BASE_URL": "",
        "TIMEFLOW_OPENAI_API_KEY": "",
        "TIMEFLOW_ALIYUN_TTS_WS_URL": "",
        "TIMEFLOW_ALIYUN_TTS_API_KEY": "",
    }
    with mock.patch.dict(os.environ, missing, clear=False):
        with pytest.raises(RuntimeError, match="Composed voice agent is not configured"):
            _build_with_environment("development", voice_agent_mode="2")


def test_voice_agent_mode_two_wires_schedule_category_event_publisher() -> None:
    environment = _composed_environment()

    with (
        mock.patch.dict(os.environ, environment, clear=False),
        mock.patch("timeflow.main.build_composed_voice_agent") as builder,
    ):
        _build_with_environment("development", voice_agent_mode="2")

    result_sink = builder.call_args.args[1]
    publisher = builder.call_args.kwargs["category_event_publisher"]
    assert publisher == result_sink.publish_schedule_category_updated


def test_lifespan_disposes_the_database_engine_owned_by_the_application() -> None:
    """应用关闭时释放由组合根创建的数据库引擎。"""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    disposed: list[bool] = []
    event.listen(engine, "engine_disposed", lambda _engine: disposed.append(True))

    with mock.patch("timeflow.main.build_engine", return_value=engine):
        application = _build_with_environment(
            "development",
            auth_access=None,
            audio_sink=_Sink(),
        )

    with TestClient(application):
        assert disposed == []

    assert disposed == [True]


def test_lifespan_does_not_dispose_an_injected_database_engine() -> None:
    """外部注入的数据库引擎仍由调用方管理生命周期。"""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    disposed: list[bool] = []
    event.listen(engine, "engine_disposed", lambda _engine: disposed.append(True))
    application = _build_with_environment(
        "development",
        auth_access=None,
        engine=engine,
        audio_sink=_Sink(),
    )

    with TestClient(application):
        pass

    assert disposed == []
    engine.dispose()


def test_building_with_tencent_and_aliyun_configured_wires_location() -> None:
    """腾讯地图和实时模型凭据都配置齐全时，组合根能正常装配位置检索能力。"""
    with mock.patch.dict(os.environ, _tencent_environment(), clear=False):
        application = _build_with_environment("production", audio_configured=True)

    assert application is not None


def test_lifespan_closes_the_owned_tencent_http_client() -> None:
    """应用关闭时释放组合根为地图检索创建的 HTTP client，跟数据库引擎释放同一套时机。"""
    client = _FakeAsyncClient(timeout=5.0)
    engine = create_engine("sqlite+pysqlite:///:memory:")

    with (
        mock.patch("timeflow.main.httpx.AsyncClient", return_value=client) as factory,
        mock.patch.dict(os.environ, _tencent_environment(), clear=False),
    ):
        application = _build_with_environment("development", auth_access=None, engine=engine)

    factory.assert_called_once()
    with TestClient(application):
        assert client.closed is False

    assert client.closed is True


def test_voice_agent_mode_two_opens_and_closes_a_tencent_http_client() -> None:
    """模式 2 与模式 1 一样由组合根创建并释放腾讯地图 HTTP client。"""
    client = _FakeAsyncClient(timeout=5.0)
    environment = {**_tencent_environment(), **_composed_environment()}

    with (
        mock.patch("timeflow.main.httpx.AsyncClient", return_value=client) as factory,
        mock.patch.dict(os.environ, environment, clear=False),
    ):
        application = _build_with_environment("development", voice_agent_mode="2")

    factory.assert_called_once()
    with TestClient(application):
        assert client.closed is False

    assert client.closed is True
