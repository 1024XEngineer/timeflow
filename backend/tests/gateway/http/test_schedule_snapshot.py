"""受保护的账号日程全量快照 HTTP 契约测试。"""

import logging
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from timeflow.business.auth import IssuedAccessTokenView
from timeflow.business.calendar import (
    AccountScheduleSnapshot,
    OccurrenceOverrideAction,
    ReminderDispositionState,
    ReminderStrength,
    ReminderType,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.gateway.http import (
    ScheduleSnapshotResponse,
    create_authenticated_account_dependency,
    create_schedule_snapshot_router,
    install_auth_http_error_handler,
)

NOW = datetime(2026, 8, 14, tzinfo=UTC)


class _Tokens:
    def __init__(self, account_id: str | None = "account-1") -> None:
        self.account_id = account_id
        self.verified: list[str] = []

    def issue(self, account_id: str) -> IssuedAccessTokenView:
        raise AssertionError(f"unexpected token issue for {account_id}")

    def verify(self, token: str) -> str | None:
        self.verified.append(token)
        return self.account_id if token == "valid-token" else None


@dataclass
class _Reader:
    result: AccountScheduleSnapshot = AccountScheduleSnapshot((), ())
    error: Exception | None = None
    calls: list[str] = field(default_factory=list)

    def get_account_snapshot(self, *, account_id: str) -> AccountScheduleSnapshot:
        self.calls.append(account_id)
        if self.error is not None:
            raise self.error
        return self.result


def _schedule(
    *,
    schedule_id: str = "schedule-1",
    account_id: str = "account-1",
    kind: ScheduleKind = ScheduleKind.ONCE,
    status: ScheduleStatus = ScheduleStatus.ACTIVE,
) -> ScheduleSnapshot:
    return ScheduleSnapshot(
        id=schedule_id,
        account_id=account_id,
        schedule_type=ScheduleType.TIME,
        schedule_kind=kind,
        title="团队会议",
        is_all_day=False,
        start_time=NOW,
        end_time=NOW + timedelta(hours=1),
        timezone="Asia/Shanghai",
        recurrence_rule="FREQ=WEEKLY" if kind is ScheduleKind.RECURRING else None,
        status=status,
        revision=1,
        created_at=NOW,
        updated_at=NOW,
        deleted_at=NOW if status is ScheduleStatus.DELETED else None,
    )


def _override(
    *,
    override_id: str = "override-1",
    schedule_id: str = "series-1",
    action: OccurrenceOverrideAction = OccurrenceOverrideAction.CANCEL,
    replacement_schedule_id: str | None = None,
    occurrence_start: datetime = NOW,
) -> ScheduleOccurrenceOverrideSnapshot:
    return ScheduleOccurrenceOverrideSnapshot(
        id=override_id,
        schedule_id=schedule_id,
        occurrence_start=occurrence_start,
        action=action,
        replacement_schedule_id=replacement_schedule_id,
        created_at=NOW,
        updated_at=NOW,
    )


def _client(
    reader: _Reader,
    *,
    account_id: str | None = "account-1",
    tokens: _Tokens | None = None,
) -> TestClient:
    application = FastAPI()
    install_auth_http_error_handler(application)
    dependency = create_authenticated_account_dependency(tokens or _Tokens(account_id))
    application.include_router(create_schedule_snapshot_router(reader, dependency))
    return TestClient(application, raise_server_exceptions=False)


def _get(client: TestClient, query: str = ""):
    return client.get(
        f"/api/v1/schedule/snapshot{query}",
        headers={"Authorization": "Bearer valid-token"},
    )


def _internal_error() -> dict[str, dict[str, str]]:
    return {
        "error": {
            "code": "SCHEDULE_SNAPSHOT_INTERNAL_ERROR",
            "message": "Schedule snapshot unavailable",
        }
    }


def test_snapshot_returns_active_deleted_rows_and_uses_only_the_authenticated_account() -> None:
    reader = _Reader(
        AccountScheduleSnapshot(
            schedules=(
                _schedule(),
                _schedule(schedule_id="deleted-1", status=ScheduleStatus.DELETED),
            ),
            occurrence_overrides=(),
        )
    )

    response = _get(_client(reader), "?account_id=attacker")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"schedules", "occurrence_overrides"}
    assert [item["status"] for item in body["schedules"]] == ["active", "deleted"]
    assert body["schedules"][0]["schedule_type"] == "time"
    assert body["schedules"][0]["created_at"] == "2026-08-14T00:00:00Z"
    assert body["occurrence_overrides"] == []
    assert reader.calls == ["account-1"]


def test_snapshot_returns_empty_arrays() -> None:
    response = _get(_client(_Reader()))

    assert response.status_code == 200
    assert response.json() == {"schedules": [], "occurrence_overrides": []}


def test_snapshot_verifies_the_bearer_token_exactly_once() -> None:
    tokens = _Tokens()

    response = _get(_client(_Reader(), tokens=tokens))

    assert response.status_code == 200
    assert tokens.verified == ["valid-token"]


@pytest.mark.parametrize(
    ("authorization", "account_id", "code", "message"),
    [
        (None, "account-1", "AUTH_REQUIRED", "Authentication required"),
        ("Bearer invalid-token", "account-1", "AUTH_INVALID_TOKEN", "Invalid access token"),
    ],
)
def test_snapshot_reuses_authentication_errors_without_calling_reader(
    authorization: str | None,
    account_id: str,
    code: str,
    message: str,
) -> None:
    reader = _Reader()
    headers = {} if authorization is None else {"Authorization": authorization}

    response = _client(reader, account_id=account_id).get(
        "/api/v1/schedule/snapshot", headers=headers
    )

    assert response.status_code == 401
    assert response.json() == {"error": {"code": code, "message": message}}
    assert reader.calls == []


def test_snapshot_accepts_a_valid_recurring_override_graph() -> None:
    reader = _Reader(
        AccountScheduleSnapshot(
            schedules=(
                _schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),
                _schedule(schedule_id="replacement-1"),
            ),
            occurrence_overrides=(
                _override(
                    action=OccurrenceOverrideAction.REPLACE,
                    replacement_schedule_id="replacement-1",
                ),
            ),
        )
    )

    response = _get(_client(reader))

    assert response.status_code == 200
    assert response.json()["occurrence_overrides"] == [
        {
            "id": "override-1",
            "schedule_id": "series-1",
            "occurrence_start": "2026-08-14T00:00:00Z",
            "action": "replace",
            "replacement_schedule_id": "replacement-1",
            "created_at": "2026-08-14T00:00:00Z",
            "updated_at": "2026-08-14T00:00:00Z",
        }
    ]


@pytest.mark.parametrize(
    "schedule",
    [
        replace(
            _schedule(),
            reminder_type=ReminderType.AT_TIME,
            reminder_trigger_at=NOW,
            reminder_strength=ReminderStrength.MEDIUM,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.BEFORE_START,
            reminder_offset_minutes=10,
            reminder_strength=ReminderStrength.MEDIUM,
        ),
        replace(
            _schedule(),
            schedule_type=ScheduleType.LOCATION,
            start_time=None,
            end_time=None,
            latitude=31.2,
            longitude=121.4,
            reminder_type=ReminderType.ARRIVE_LOCATION,
            reminder_strength=ReminderStrength.MEDIUM,
        ),
        replace(
            _schedule(),
            schedule_type=ScheduleType.LOCATION,
            start_time=None,
            end_time=None,
            latitude=31.2,
            longitude=121.4,
            reminder_type=ReminderType.RETURN_TO_RECORDED_LOCATION,
            reminder_strength=ReminderStrength.HIGH,
            reminder_disposition_state=ReminderDispositionState.CONFIRMED,
        ),
    ],
    ids=["at-time", "before-start", "arrive-location", "return-to-location"],
)
def test_snapshot_accepts_each_valid_reminder_field_combination(
    schedule: ScheduleSnapshot,
) -> None:
    response = _get(
        _client(_Reader(AccountScheduleSnapshot(schedules=(schedule,), occurrence_overrides=())))
    )

    assert response.status_code == 200
    assert response.json()["schedules"][0]["reminder_type"] == schedule.reminder_type


@pytest.mark.parametrize(
    "snapshot",
    [
        AccountScheduleSnapshot((_schedule(account_id="account-2"),), ()),
        AccountScheduleSnapshot((_schedule(), _schedule()), ()),
        AccountScheduleSnapshot((replace(_schedule(), revision=0),), ()),
        AccountScheduleSnapshot((replace(_schedule(), created_at=NOW.replace(tzinfo=None)),), ()),
        AccountScheduleSnapshot((replace(_schedule(), updated_at=NOW.replace(tzinfo=None)),), ()),
        AccountScheduleSnapshot((), (_override(),)),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1"),),
            (_override(),),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (_override(replacement_schedule_id="replacement-1"),),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (_override(action=OccurrenceOverrideAction.REPLACE),),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (
                _override(
                    action=OccurrenceOverrideAction.REPLACE, replacement_schedule_id="missing"
                ),
            ),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (_override(), _override()),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (_override(), _override(override_id="override-2")),
        ),
        AccountScheduleSnapshot(
            (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
            (_override(occurrence_start=NOW.replace(tzinfo=None)),),
        ),
    ],
    ids=[
        "cross-account",
        "duplicate-schedule-id",
        "invalid-revision",
        "naive-created-at",
        "naive-updated-at",
        "missing-parent",
        "non-recurring-parent",
        "cancel-with-replacement",
        "replace-without-target",
        "replace-with-missing-target",
        "duplicate-override-id",
        "duplicate-occurrence-key",
        "naive-occurrence-start",
    ],
)
def test_invalid_snapshot_graph_returns_one_sanitized_500(
    snapshot: AccountScheduleSnapshot,
) -> None:
    response = _get(_client(_Reader(snapshot)))

    assert response.status_code == 500
    assert response.json() == _internal_error()


@pytest.mark.parametrize(
    "schedule",
    [
        replace(_schedule(), is_all_day="false"),
        replace(_schedule(), revision="1"),
        replace(_schedule(), latitude="31.2", longitude="121.4"),
    ],
    ids=["string-boolean", "string-integer", "string-coordinates"],
)
def test_strict_snapshot_field_type_corruption_returns_one_sanitized_500(
    schedule: ScheduleSnapshot,
) -> None:
    response = _get(_client(_Reader(AccountScheduleSnapshot((schedule,), ()))))

    assert response.status_code == 500
    assert response.json() == _internal_error()


@pytest.mark.parametrize(
    "occurrence_override",
    [
        replace(_override(), action="cancel"),
        replace(_override(), occurrence_start=NOW.isoformat()),
    ],
    ids=["string-action", "string-occurrence-start"],
)
def test_strict_override_field_type_corruption_returns_one_sanitized_500(
    occurrence_override: ScheduleOccurrenceOverrideSnapshot,
) -> None:
    snapshot = AccountScheduleSnapshot(
        (_schedule(schedule_id="series-1", kind=ScheduleKind.RECURRING),),
        (occurrence_override,),
    )

    response = _get(_client(_Reader(snapshot)))

    assert response.status_code == 500
    assert response.json() == _internal_error()


@pytest.mark.parametrize(
    "schedule",
    [
        replace(_schedule(), start_time=None),
        replace(
            _schedule(),
            schedule_type=ScheduleType.LOCATION,
            latitude=31.2,
            longitude=121.4,
        ),
        replace(_schedule(), end_time=NOW),
        replace(_schedule(), timezone="Not/A_Real_Zone"),
        replace(_schedule(), schedule_kind=ScheduleKind.RECURRING, recurrence_rule=None),
        replace(_schedule(), recurrence_rule="FREQ=DAILY"),
        replace(_schedule(), latitude=31.2, longitude=None),
        replace(_schedule(), reminder_strength=ReminderStrength.MEDIUM),
        replace(
            _schedule(),
            reminder_type=ReminderType.AT_TIME,
            reminder_strength=None,
            reminder_trigger_at=NOW,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.AT_TIME,
            reminder_strength=ReminderStrength.MEDIUM,
            reminder_trigger_at=None,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.AT_TIME,
            reminder_strength=ReminderStrength.MEDIUM,
            reminder_trigger_at=NOW,
            reminder_offset_minutes=10,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.BEFORE_START,
            reminder_strength=ReminderStrength.MEDIUM,
            reminder_offset_minutes=None,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.BEFORE_START,
            reminder_strength=ReminderStrength.MEDIUM,
            reminder_trigger_at=NOW,
            reminder_offset_minutes=10,
        ),
        replace(
            _schedule(),
            reminder_type=ReminderType.ARRIVE_LOCATION,
            reminder_strength=ReminderStrength.MEDIUM,
        ),
        replace(
            _schedule(),
            latitude=31.2,
            longitude=121.4,
            reminder_type=ReminderType.RETURN_TO_RECORDED_LOCATION,
            reminder_strength=ReminderStrength.MEDIUM,
            reminder_offset_minutes=10,
        ),
        replace(_schedule(), deleted_at=NOW),
        replace(_schedule(status=ScheduleStatus.DELETED), deleted_at=None),
        replace(
            _schedule(),
            reminder_disposition_state=ReminderDispositionState.CONFIRMED,
        ),
    ],
    ids=[
        "time-without-start",
        "location-with-start",
        "end-not-after-start",
        "invalid-iana-timezone",
        "recurring-without-rule",
        "once-with-rule",
        "unpaired-coordinates",
        "reminder-fields-without-type",
        "reminder-without-strength",
        "at-time-without-trigger",
        "at-time-with-offset",
        "before-start-without-offset",
        "before-start-with-trigger",
        "location-reminder-without-coordinates",
        "location-reminder-with-time-offset",
        "active-with-deleted-at",
        "deleted-without-deleted-at",
        "disposition-without-reminder",
    ],
)
def test_cross_field_contract_corruption_returns_one_sanitized_500(
    schedule: ScheduleSnapshot,
) -> None:
    response = _get(_client(_Reader(AccountScheduleSnapshot((schedule,), ()))))

    assert response.status_code == 500
    assert response.json() == _internal_error()


def test_reader_failure_does_not_leak_exception_detail_to_response_or_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "postgresql://user:password@host/database"
    reader = _Reader(error=RuntimeError(secret))

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.schedule_snapshot"):
        response = _get(_client(reader))

    assert response.status_code == 500
    assert response.json() == _internal_error()
    assert secret not in response.text
    assert secret not in caplog.text
    record = caplog.records[-1]
    assert record.event_id.startswith("schedule_snapshot_event_")
    assert record.error_code == "SCHEDULE_SNAPSHOT_INTERNAL_ERROR"


def test_serialization_failure_returns_one_sanitized_500(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "corrupt field value from account-2"

    def fail_serialization(*_args: object, **_kwargs: object) -> dict[str, object]:
        raise RuntimeError(secret)

    monkeypatch.setattr(ScheduleSnapshotResponse, "model_dump", fail_serialization)

    with caplog.at_level(logging.ERROR, logger="timeflow.gateway.http.schedule_snapshot"):
        response = _get(_client(_Reader()))

    assert response.status_code == 500
    assert response.json() == _internal_error()
    assert secret not in response.text
    assert secret not in caplog.text


def test_openapi_documents_shared_authentication_and_snapshot_error_envelopes() -> None:
    client = _client(_Reader())

    document = client.get("/openapi.json").json()
    operation = document["paths"]["/api/v1/schedule/snapshot"]["get"]

    assert operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ScheduleSnapshotResponse"
    )
    assert operation["responses"]["401"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/AuthErrorEnvelope"
    )
    assert operation["responses"]["500"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ScheduleSnapshotErrorEnvelope"
    )
    assert operation["security"] == [{"HTTPBearer": []}]
    assert document["components"]["securitySchemes"]["HTTPBearer"] == {
        "type": "http",
        "scheme": "bearer",
    }

    schedule_schema = document["components"]["schemas"]["ScheduleHttpSnapshot"]
    required_nullable = {"latitude", "longitude", "reminder_offset_minutes"}
    assert required_nullable <= set(schedule_schema["required"])
    for field_name in required_nullable:
        assert {"type": "null"} in schedule_schema["properties"][field_name]["anyOf"]
