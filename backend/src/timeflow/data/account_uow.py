"""账户认证的 SQLAlchemy 事务适配器。"""

from types import TracebackType

from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.auth import AccountRepositoryPort
from timeflow.data.repositories.account import AccountRepository


class SqlAlchemyAuthUnitOfWork:
    """每个认证事务仅持有一个 Session。"""

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._session: Session | None = None
        self._accounts: AccountRepository | None = None
        self._committed = False

    @property
    def accounts(self) -> AccountRepositoryPort:
        """返回当前事务的仓储，事务外访问会失败。"""
        if self._accounts is None:
            raise RuntimeError("The authentication unit of work is not active")
        return self._accounts

    def __enter__(self) -> "SqlAlchemyAuthUnitOfWork":
        if self._session is not None:
            raise RuntimeError("The authentication unit of work is already active")
        self._session = self._session_factory()
        self._committed = False
        self._accounts = AccountRepository(self._session)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        session = self._require_session()
        try:
            if exc_type is not None or not self._committed:
                session.rollback()
        finally:
            if self._accounts is not None:
                self._accounts.close()
            session.close()
            self._session = None
            self._accounts = None
            self._committed = False

    def commit(self) -> None:
        self._require_session().commit()
        self._committed = True

    def rollback(self) -> None:
        self._require_session().rollback()
        self._committed = False

    def _require_session(self) -> Session:
        if self._session is None:
            raise RuntimeError("The authentication unit of work is not active")
        return self._session


__all__ = ["SqlAlchemyAuthUnitOfWork"]
