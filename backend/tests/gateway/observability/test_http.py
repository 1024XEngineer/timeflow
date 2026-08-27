"""Gateway HTTP metrics and scrape-path behaviour."""

from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.testclient import TestClient
from observability_support import metric_value

from timeflow.business.auth import AuthAccessResult
from timeflow.gateway.http import create_auth_router
from timeflow.gateway.observability.http import (
    install_http_observability,
    record_auth_access,
    record_health,
    record_reminder_state,
    record_schedule_snapshot,
)


@dataclass
class _AccessStub:
    result: AuthAccessResult

    def access(self, username: str, password: str) -> AuthAccessResult:
        del username, password
        return self.result


def test_auth_success_increments_the_route_counter() -> None:
    before = metric_value("timeflow_http_auth_access_total", {"result": "success"})
    application = FastAPI()
    application.include_router(
        create_auth_router(_AccessStub(AuthAccessResult("acc_001", "token", 3600)))
    )

    response = TestClient(application).post(
        "/api/v1/auth/access",
        json={"username": "Alice", "password": "strong-password"},
    )

    assert response.status_code == 200
    assert metric_value("timeflow_http_auth_access_total", {"result": "success"}) == before + 1


def test_http_middleware_records_method_route_and_status() -> None:
    application = FastAPI()
    install_http_observability(application)

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    before = metric_value(
        "timeflow_http_requests_total",
        {"method": "GET", "route": "/api/v1/health", "status_code": "200"},
    )
    client = TestClient(application)
    response = client.get("/api/v1/health")
    scrape = client.get("/metrics")

    assert response.status_code == 200
    assert scrape.status_code == 200
    assert "timeflow_http_requests_total" in scrape.text
    assert (
        metric_value(
            "timeflow_http_requests_total",
            {"method": "GET", "route": "/api/v1/health", "status_code": "200"},
        )
        == before + 1
    )


def test_metrics_path_is_not_counted_as_an_application_request() -> None:
    application = FastAPI()
    install_http_observability(application)
    before = metric_value(
        "timeflow_http_requests_total",
        {"method": "GET", "route": "/metrics", "status_code": "200"},
    )

    TestClient(application).get("/metrics")

    assert (
        metric_value(
            "timeflow_http_requests_total",
            {"method": "GET", "route": "/metrics", "status_code": "200"},
        )
        == before
    )


def test_record_auth_access_rejects_unbounded_result_labels() -> None:
    before_other = metric_value("timeflow_http_auth_access_total", {"result": "other"})
    record_auth_access("unexpected-label", 0.01)
    assert metric_value("timeflow_http_auth_access_total", {"result": "other"}) == before_other + 1


def test_snapshot_and_reminder_counters_use_closed_results() -> None:
    snapshot_before = metric_value("timeflow_http_schedule_snapshot_total", {"result": "success"})
    reminder_before = metric_value("timeflow_http_reminder_state_total", {"result": "confirmed"})
    not_found_before = metric_value("timeflow_http_reminder_state_total", {"result": "not_found"})
    conflict_before = metric_value("timeflow_http_reminder_state_total", {"result": "conflict"})
    errors_before = metric_value("timeflow_http_schedule_snapshot_server_errors_total")
    record_schedule_snapshot("success", 0.02, server_error=False)
    record_schedule_snapshot("error", 0.02, server_error=True)
    record_reminder_state("confirmed", 0.01)
    record_reminder_state("not_found", 0.01)
    record_reminder_state("conflict", 0.01)
    record_health({"process": "ok", "database": "ok", "asr": "unconfigured"})

    assert (
        metric_value("timeflow_http_schedule_snapshot_total", {"result": "success"})
        == snapshot_before + 1
    )
    assert (
        metric_value("timeflow_http_reminder_state_total", {"result": "confirmed"})
        == reminder_before + 1
    )
    assert (
        metric_value("timeflow_http_reminder_state_total", {"result": "not_found"})
        == not_found_before + 1
    )
    assert (
        metric_value("timeflow_http_reminder_state_total", {"result": "conflict"})
        == conflict_before + 1
    )
    assert metric_value("timeflow_http_schedule_snapshot_server_errors_total") == errors_before + 1


def test_known_http_routes_use_the_template_not_the_raw_path() -> None:
    application = FastAPI()
    install_http_observability(application)
    application.include_router(
        create_auth_router(_AccessStub(AuthAccessResult("acc_001", "token", 3600)))
    )
    before = metric_value(
        "timeflow_http_requests_total",
        {"method": "POST", "route": "/api/v1/auth/access", "status_code": "200"},
    )

    response = TestClient(application).post(
        "/api/v1/auth/access",
        json={"username": "Alice", "password": "strong-password"},
    )

    assert response.status_code == 200
    assert (
        metric_value(
            "timeflow_http_requests_total",
            {"method": "POST", "route": "/api/v1/auth/access", "status_code": "200"},
        )
        == before + 1
    )


def test_unmatched_http_paths_share_one_route_label() -> None:
    application = FastAPI()
    install_http_observability(application)
    before = metric_value(
        "timeflow_http_requests_total",
        {"method": "GET", "route": "unmatched", "status_code": "404"},
    )

    response = TestClient(application).get("/no-such-route")

    assert response.status_code == 404
    assert (
        metric_value(
            "timeflow_http_requests_total",
            {"method": "GET", "route": "unmatched", "status_code": "404"},
        )
        == before + 1
    )


def test_http_middleware_records_unhandled_exceptions_as_500() -> None:
    application = FastAPI()
    install_http_observability(application)

    @application.get("/boom")
    def boom() -> None:
        raise RuntimeError("must not become a metric label")

    before = metric_value(
        "timeflow_http_requests_total",
        {"method": "GET", "route": "unmatched", "status_code": "500"},
    )
    try:
        TestClient(application, raise_server_exceptions=True).get("/boom")
    except RuntimeError:
        pass

    assert (
        metric_value(
            "timeflow_http_requests_total",
            {"method": "GET", "route": "unmatched", "status_code": "500"},
        )
        == before + 1
    )
