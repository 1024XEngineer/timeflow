"""SQLAlchemy transaction adapter for schedule application use cases."""

from types import TracebackType

from sqlalchemy.orm import Session, sessionmaker

from timeflow.data.repositories.schedule import ScheduleRepository


class SqlAlchemyScheduleUnitOfWork:
    """Own one SQLAlchemy Session and expose its account-scoped repository."""

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._session: Session | None = None
        self.schedules: ScheduleRepository

    def __enter__(self) -> "SqlAlchemyScheduleUnitOfWork":
        self._session = self._session_factory()
        self.schedules = ScheduleRepository(self._session)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        session = self._require_session()
        if exc_type is not None:
            session.rollback()
        session.close()
        self._session = None

    def commit(self) -> None:
        """Commit all repository writes performed by the current use case."""
        self._require_session().commit()

    def _require_session(self) -> Session:
        if self._session is None:
            raise RuntimeError("The schedule unit of work is not active")
        return self._session


__all__ = ["SqlAlchemyScheduleUnitOfWork"]
