"""账户创建与密码访问应用服务。"""

from collections.abc import Callable
from datetime import UTC, datetime
from uuid import uuid4

from timeflow.business.auth.contracts import (
    AccessTokenService,
    AccountRecord,
    AuthAccessResult,
    AuthCredentials,
    AuthError,
    AuthErrorCode,
    AuthUnitOfWorkFactory,
    NewAccount,
    PasswordHasher,
    UsernameConflictError,
)


class AuthAccessService:
    """创建新账户，或认证已存在用户名对应的账户。"""

    def __init__(
        self,
        unit_of_work_factory: AuthUnitOfWorkFactory,
        password_hasher: PasswordHasher,
        access_token_service: AccessTokenService,
        *,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._unit_of_work_factory = unit_of_work_factory
        self._password_hasher = password_hasher
        self._access_token_service = access_token_service
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory or (lambda: uuid4().hex)

    def access(self, username: str, password: str) -> AuthAccessResult:
        """规范化凭据，持久化或验证账户，然后签发令牌。"""
        credentials = AuthCredentials(username, password)
        account, requires_verification = self._get_or_create(credentials)
        if requires_verification and not self._password_hasher.verify(
            credentials.password, account.password_hash
        ):
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)

        issued = self._access_token_service.issue(account.id)
        return AuthAccessResult(account.id, issued.access_token, issued.expires_in)

    def _get_or_create(self, credentials: AuthCredentials) -> tuple[AccountRecord, bool]:
        try:
            with self._unit_of_work_factory() as unit_of_work:
                existing = unit_of_work.accounts.get_by_username(credentials.username)
                if existing is not None:
                    return existing, True

                now = self._clock()
                created = unit_of_work.accounts.add(
                    NewAccount(
                        id=self._new_account_id(),
                        username=credentials.username,
                        password_hash=self._password_hasher.hash(credentials.password),
                        created_at=now,
                        updated_at=now,
                    )
                )
                unit_of_work.commit()
                return created, False
        except UsernameConflictError:
            return self._read_conflict_winner(credentials.username), True

    def _read_conflict_winner(self, username: str) -> AccountRecord:
        with self._unit_of_work_factory() as unit_of_work:
            winner = unit_of_work.accounts.get_by_username(username)
        if winner is None:
            raise RuntimeError("Username conflict winner was not visible in a new transaction")
        return winner

    def _new_account_id(self) -> str:
        account_id = f"acc_{self._id_factory()}"
        if len(account_id) > 64:
            raise RuntimeError("Generated account id exceeds the persistence limit")
        return account_id


__all__ = ["AuthAccessService"]
