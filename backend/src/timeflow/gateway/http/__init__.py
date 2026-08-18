"""HTTP 网关工厂与可信认证上下文。"""

from timeflow.gateway.http.auth import (
    AUTH_RATE_LIMITED,
    AuthAccess,
    AuthAccessRequest,
    AuthAccessResponse,
    AuthErrorDetail,
    AuthErrorEnvelope,
    AuthHttpError,
    auth_http_error_handler,
    create_auth_router,
    install_auth_http_error_handler,
)
from timeflow.gateway.http.dependencies import (
    AuthenticatedAccount,
    AuthenticatedAccountDependency,
    create_authenticated_account_dependency,
)
from timeflow.gateway.http.rate_limit import AuthRateLimiter, RateLimitPolicy
from timeflow.gateway.http.reminder_state import create_reminder_state_router
from timeflow.gateway.http.schedule_snapshot import (
    ScheduleHttpSnapshot,
    ScheduleOccurrenceOverrideHttpSnapshot,
    ScheduleSnapshotErrorDetail,
    ScheduleSnapshotErrorEnvelope,
    ScheduleSnapshotResponse,
    create_schedule_snapshot_router,
)

__all__ = [
    "AuthAccess",
    "AuthAccessRequest",
    "AuthAccessResponse",
    "AuthErrorDetail",
    "AuthErrorEnvelope",
    "AuthHttpError",
    "AUTH_RATE_LIMITED",
    "AuthRateLimiter",
    "AuthenticatedAccount",
    "AuthenticatedAccountDependency",
    "auth_http_error_handler",
    "create_auth_router",
    "create_authenticated_account_dependency",
    "create_reminder_state_router",
    "install_auth_http_error_handler",
    "RateLimitPolicy",
    "ScheduleHttpSnapshot",
    "ScheduleOccurrenceOverrideHttpSnapshot",
    "ScheduleSnapshotErrorDetail",
    "ScheduleSnapshotErrorEnvelope",
    "ScheduleSnapshotResponse",
    "create_schedule_snapshot_router",
]
