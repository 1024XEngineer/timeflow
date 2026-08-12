"""HTTP 网关工厂与可信认证上下文。"""

from timeflow.gateway.http.auth import (
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

__all__ = [
    "AuthAccess",
    "AuthAccessRequest",
    "AuthAccessResponse",
    "AuthErrorDetail",
    "AuthErrorEnvelope",
    "AuthHttpError",
    "AuthenticatedAccount",
    "AuthenticatedAccountDependency",
    "auth_http_error_handler",
    "create_auth_router",
    "create_authenticated_account_dependency",
    "install_auth_http_error_handler",
]
