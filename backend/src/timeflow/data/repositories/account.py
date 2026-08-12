"""认证账户的 SQLAlchemy 持久化适配器。"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from timeflow.business.auth import AccountRecord, NewAccount, UsernameConflictError
from timeflow.data.models import Account

_USERNAME_CONSTRAINT = "uq_accounts_username"
_SQLITE_USERNAME_CONFLICT = "UNIQUE constraint failed: accounts.username"


class AccountRepository:
    """读取并刷新账户记录，但不管理事务。"""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_username(self, username: str) -> AccountRecord | None:
        model = self._session.scalar(select(Account).where(Account.username == username))
        return None if model is None else _to_record(model)

    def add(self, account: NewAccount) -> AccountRecord:
        model = Account(
            id=account.id,
            username=account.username,
            password_hash=account.password_hash,
            created_at=account.created_at,
            updated_at=account.updated_at,
        )
        self._session.add(model)
        try:
            self._session.flush()
        except IntegrityError as error:
            if _is_username_conflict(error):
                raise UsernameConflictError from None
            raise
        return _to_record(model)


def _to_record(model: Account) -> AccountRecord:
    return AccountRecord(model.id, model.username, model.password_hash)


def _is_username_conflict(error: IntegrityError) -> bool:
    original: Any = error.orig
    diagnostic = getattr(original, "diag", None)
    if getattr(diagnostic, "constraint_name", None) == _USERNAME_CONSTRAINT:
        return True
    return _SQLITE_USERNAME_CONFLICT in str(original)


__all__ = ["AccountRepository"]
