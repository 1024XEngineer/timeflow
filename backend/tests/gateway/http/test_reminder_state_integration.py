"""End-to-end backend test for final reminder confirmation sync."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime

from auth_test_support import build_test_token_service
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from timeflow.business.auth import AuthAccessResult
from timeflow.business.calendar import (
    ReminderDispositionState,
    ReminderStrength,
    ReminderType,
    ScheduleKind,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.data.database import Base
from timeflow.data.models import Account
from timeflow.data.repositories import ScheduleRepository
from timeflow.gateway.websocket.ports import StreamContext
from timeflow.main import create_app


class _Sink:
    async def consume(
        self,
        chunks: AsyncIterator[bytes],
        stream: StreamContext,
    ) -> None:
        del stream
        async for _chunk in chunks:
            pass


class _UnusedAuthAccess:
    def access(self, username: str, password: str) -> AuthAccessResult:
        raise AssertionError(f"unexpected auth access for {username!r} and password")


def test_client_request_commits_once_through_real_backend_layers() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    account_id = "account-reminder"
    schedule_id = "schedule-reminder"
    initial_time = datetime(2026, 8, 16, tzinfo=UTC)
    with Session(engine) as session:
        session.add(
            Account(
                id=account_id,
                username="reminder@example.com",
                password_hash="test-password-hash",
                created_at=initial_time,
                updated_at=initial_time,
            )
        )
        repository = ScheduleRepository(session)
        repository.add_schedule(
            ScheduleSnapshot(
                id=schedule_id,
                account_id=account_id,
                schedule_type=ScheduleType.TIME,
                schedule_kind=ScheduleKind.ONCE,
                title="Take medicine",
                is_all_day=False,
                timezone="Asia/Shanghai",
                status=ScheduleStatus.ACTIVE,
                revision=1,
                created_at=initial_time,
                updated_at=initial_time,
                start_time=datetime(2026, 8, 18, tzinfo=UTC),
                reminder_type=ReminderType.BEFORE_START,
                reminder_offset_minutes=10,
                reminder_strength=ReminderStrength.MEDIUM,
            )
        )
        session.commit()

    tokens = build_test_token_service()
    issued = tokens.issue(account_id)
    application = create_app(
        audio_sink=_Sink(),
        auth_access=_UnusedAuthAccess(),
        access_token_service=tokens,
        engine=engine,
    )
    request = {
        "schedule_id": schedule_id,
        "disposition_state": "confirmed",
    }
    headers = {"Authorization": f"Bearer {issued.access_token}"}

    try:
        with TestClient(application) as client:
            first = client.put(
                "/api/v1/schedule/reminder-state",
                headers=headers,
                json=request,
            )
            duplicate = client.put(
                "/api/v1/schedule/reminder-state",
                headers=headers,
                json=request,
            )

        assert first.status_code == 200
        assert duplicate.status_code == 200
        assert first.json() == duplicate.json()
        assert first.json()["disposition_state"] == "confirmed"

        with Session(engine) as session:
            persisted = ScheduleRepository(session).get_schedule(
                account_id=account_id,
                schedule_id=schedule_id,
            )
        assert persisted is not None
        assert persisted.reminder_disposition_state is ReminderDispositionState.CONFIRMED
        assert persisted.revision == 2
        assert persisted.updated_at != initial_time.replace(tzinfo=None)
    finally:
        engine.dispose()
