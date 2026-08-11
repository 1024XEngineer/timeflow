"""SQLAlchemy persistence adapter for schedules and occurrence overrides."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from timeflow.business.calendar.contracts import (
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
from timeflow.business.calendar.ports import ScheduleRevisionConflictError
from timeflow.data.models import Schedule, ScheduleOccurrenceOverride


class ScheduleRepository:
    """Account-scoped persistence primitives used by the schedule service.

    The repository flushes changes but never commits or rolls back. Transaction
    ownership stays with the later application service implementation.
    """

    def __init__(self, session: Session) -> None:
        self._session = session

    def add_schedule(self, snapshot: ScheduleSnapshot) -> ScheduleSnapshot:
        """Insert one cloud schedule without committing the surrounding transaction."""
        model = Schedule(**_schedule_values(snapshot))
        self._session.add(model)
        self._session.flush()
        return _to_schedule_snapshot(model)

    def get_schedule(
        self,
        *,
        account_id: str,
        schedule_id: str,
        include_deleted: bool = False,
    ) -> ScheduleSnapshot | None:
        """Return one schedule only when it belongs to the requested account."""
        statement = select(Schedule).where(
            Schedule.account_id == account_id,
            Schedule.id == schedule_id,
        )
        if not include_deleted:
            statement = statement.where(Schedule.status == ScheduleStatus.ACTIVE.value)

        model = self._session.scalar(statement)
        return None if model is None else _to_schedule_snapshot(model)

    def list_schedules(
        self,
        *,
        account_id: str,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]:
        """List schedules for exactly one account in deterministic order."""
        statement = select(Schedule).where(Schedule.account_id == account_id)
        if not include_deleted:
            statement = statement.where(Schedule.status == ScheduleStatus.ACTIVE.value)
        statement = statement.order_by(Schedule.start_time, Schedule.created_at, Schedule.id)

        return tuple(_to_schedule_snapshot(model) for model in self._session.scalars(statement))

    def list_schedule_candidates(
        self,
        *,
        account_id: str,
        starts_at_or_after: datetime | None,
        starts_before: datetime | None,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]:
        """Coarsely filter one-time rows and possible recurring matches.

        PostgreSQL never parses RRULE. One-time rows are bounded directly by
        their start, while recurring rows remain candidates when their series
        started before the exclusive query end. The application service makes
        the final occurrence and override decision.
        """
        once_filters = [Schedule.schedule_kind == ScheduleKind.ONCE.value]
        recurring_filters = [Schedule.schedule_kind == ScheduleKind.RECURRING.value]
        if starts_at_or_after is not None:
            once_filters.append(Schedule.start_time >= starts_at_or_after)
        if starts_before is not None:
            once_filters.append(Schedule.start_time < starts_before)
            recurring_filters.append(Schedule.start_time < starts_before)

        statement = select(Schedule).where(
            Schedule.account_id == account_id,
            or_(and_(*once_filters), and_(*recurring_filters)),
        )
        if not include_deleted:
            statement = statement.where(Schedule.status == ScheduleStatus.ACTIVE.value)
        statement = statement.order_by(Schedule.start_time, Schedule.created_at, Schedule.id)
        return tuple(_to_schedule_snapshot(model) for model in self._session.scalars(statement))

    def update_schedule(
        self,
        *,
        snapshot: ScheduleSnapshot,
        expected_revision: int,
    ) -> ScheduleSnapshot | None:
        """Atomically replace mutable fields and increment the persisted revision.

        Returns ``None`` when the schedule is absent from the account. Raises
        ``ScheduleRevisionConflictError`` when the account owns the schedule but
        its current revision differs from ``expected_revision``.
        """
        statement = (
            update(Schedule)
            .where(
                Schedule.id == snapshot.id,
                Schedule.account_id == snapshot.account_id,
                Schedule.revision == expected_revision,
            )
            .values(
                **_schedule_update_values(snapshot),
                revision=Schedule.revision + 1,
            )
            .returning(Schedule)
        )
        model = self._session.scalars(statement).one_or_none()
        if model is not None:
            return _to_schedule_snapshot(model)

        actual_revision = self._session.scalar(
            select(Schedule.revision).where(
                Schedule.id == snapshot.id,
                Schedule.account_id == snapshot.account_id,
            )
        )
        if actual_revision is not None:
            raise ScheduleRevisionConflictError(
                schedule_id=snapshot.id,
                expected_revision=expected_revision,
                actual_revision=actual_revision,
            )
        return None

    def add_occurrence_override(
        self,
        *,
        account_id: str,
        snapshot: ScheduleOccurrenceOverrideSnapshot,
    ) -> ScheduleOccurrenceOverrideSnapshot | None:
        """Insert an override only for schedules owned by the requested account."""
        if not self._schedule_belongs_to_account(account_id, snapshot.schedule_id):
            return None
        if snapshot.replacement_schedule_id is not None and not self._schedule_belongs_to_account(
            account_id, snapshot.replacement_schedule_id
        ):
            return None

        model = ScheduleOccurrenceOverride(
            id=snapshot.id,
            schedule_id=snapshot.schedule_id,
            occurrence_start=snapshot.occurrence_start,
            action=snapshot.action.value,
            replacement_schedule_id=snapshot.replacement_schedule_id,
            created_at=snapshot.created_at,
            updated_at=snapshot.updated_at,
        )
        self._session.add(model)
        self._session.flush()
        return _to_override_snapshot(model)

    def get_occurrence_override(
        self,
        *,
        account_id: str,
        override_id: str,
    ) -> ScheduleOccurrenceOverrideSnapshot | None:
        """Return one override through an account-scoped schedule join."""
        statement = (
            select(ScheduleOccurrenceOverride)
            .join(Schedule, Schedule.id == ScheduleOccurrenceOverride.schedule_id)
            .where(
                Schedule.account_id == account_id,
                ScheduleOccurrenceOverride.id == override_id,
            )
        )
        model = self._session.scalar(statement)
        return None if model is None else _to_override_snapshot(model)

    def update_occurrence_override(
        self,
        *,
        account_id: str,
        schedule_id: str,
        occurrence_start: datetime,
        action: OccurrenceOverrideAction,
        replacement_schedule_id: str | None,
        updated_at: datetime,
    ) -> ScheduleOccurrenceOverrideSnapshot | None:
        """Update the existing override identified by its schedule occurrence.

        This persistence operation deliberately does not increment the parent
        schedule revision. The application service must call ``update_schedule``
        with the expected revision in the same Session transaction so a conflict
        rolls back both aggregate changes together.
        """
        if not self._schedule_belongs_to_account(account_id, schedule_id):
            return None
        if replacement_schedule_id is not None and not self._schedule_belongs_to_account(
            account_id, replacement_schedule_id
        ):
            return None

        statement = (
            update(ScheduleOccurrenceOverride)
            .where(
                ScheduleOccurrenceOverride.schedule_id == schedule_id,
                ScheduleOccurrenceOverride.occurrence_start == occurrence_start,
            )
            .values(
                action=action.value,
                replacement_schedule_id=replacement_schedule_id,
                updated_at=updated_at,
            )
            .returning(ScheduleOccurrenceOverride)
        )
        model = self._session.scalars(statement).one_or_none()
        return None if model is None else _to_override_snapshot(model)

    def list_occurrence_overrides(
        self,
        *,
        account_id: str,
        schedule_id: str | None = None,
    ) -> tuple[ScheduleOccurrenceOverrideSnapshot, ...]:
        """List overrides whose recurring schedules belong to one account."""
        statement = (
            select(ScheduleOccurrenceOverride)
            .join(Schedule, Schedule.id == ScheduleOccurrenceOverride.schedule_id)
            .where(Schedule.account_id == account_id)
        )
        if schedule_id is not None:
            statement = statement.where(ScheduleOccurrenceOverride.schedule_id == schedule_id)
        statement = statement.order_by(
            ScheduleOccurrenceOverride.occurrence_start,
            ScheduleOccurrenceOverride.id,
        )
        return tuple(_to_override_snapshot(model) for model in self._session.scalars(statement))

    def _schedule_belongs_to_account(self, account_id: str, schedule_id: str) -> bool:
        statement = select(Schedule.id).where(
            Schedule.account_id == account_id,
            Schedule.id == schedule_id,
        )
        return self._session.scalar(statement) is not None


def _schedule_values(snapshot: ScheduleSnapshot) -> dict[str, object]:
    """Map the framework-independent snapshot to ORM column values."""
    return {
        "id": snapshot.id,
        "account_id": snapshot.account_id,
        "schedule_type": snapshot.schedule_type.value,
        "schedule_kind": snapshot.schedule_kind.value,
        "title": snapshot.title,
        "is_all_day": snapshot.is_all_day,
        "start_time": snapshot.start_time,
        "end_time": snapshot.end_time,
        "timezone": snapshot.timezone,
        "recurrence_rule": snapshot.recurrence_rule,
        "location_name": snapshot.location_name,
        "latitude": None if snapshot.latitude is None else Decimal(str(snapshot.latitude)),
        "longitude": None if snapshot.longitude is None else Decimal(str(snapshot.longitude)),
        "reminder_type": None if snapshot.reminder_type is None else snapshot.reminder_type.value,
        "reminder_trigger_at": snapshot.reminder_trigger_at,
        "reminder_offset_minutes": snapshot.reminder_offset_minutes,
        "reminder_strength": (
            None if snapshot.reminder_strength is None else snapshot.reminder_strength.value
        ),
        "reminder_disposition_state": (
            None
            if snapshot.reminder_disposition_state is None
            else snapshot.reminder_disposition_state.value
        ),
        "status": snapshot.status.value,
        "revision": snapshot.revision,
        "created_at": snapshot.created_at,
        "updated_at": snapshot.updated_at,
        "deleted_at": snapshot.deleted_at,
    }


def _schedule_update_values(snapshot: ScheduleSnapshot) -> dict[str, object]:
    """Map only fields that the update contract permits callers to replace."""
    values = _schedule_values(snapshot)
    mutable_fields = (
        "schedule_type",
        "schedule_kind",
        "title",
        "is_all_day",
        "start_time",
        "end_time",
        "timezone",
        "recurrence_rule",
        "location_name",
        "latitude",
        "longitude",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "reminder_strength",
        "reminder_disposition_state",
        "status",
        "updated_at",
        "deleted_at",
    )
    return {field: values[field] for field in mutable_fields}


def _to_schedule_snapshot(model: Schedule) -> ScheduleSnapshot:
    """Map one ORM row to the shared final cloud snapshot contract."""
    return ScheduleSnapshot(
        id=model.id,
        account_id=model.account_id,
        schedule_type=ScheduleType(model.schedule_type),
        schedule_kind=ScheduleKind(model.schedule_kind),
        title=model.title,
        is_all_day=model.is_all_day,
        timezone=model.timezone,
        status=ScheduleStatus(model.status),
        revision=model.revision,
        created_at=model.created_at,
        updated_at=model.updated_at,
        start_time=model.start_time,
        end_time=model.end_time,
        recurrence_rule=model.recurrence_rule,
        location_name=model.location_name,
        latitude=None if model.latitude is None else float(model.latitude),
        longitude=None if model.longitude is None else float(model.longitude),
        reminder_type=None if model.reminder_type is None else ReminderType(model.reminder_type),
        reminder_trigger_at=model.reminder_trigger_at,
        reminder_offset_minutes=model.reminder_offset_minutes,
        reminder_strength=(
            None if model.reminder_strength is None else ReminderStrength(model.reminder_strength)
        ),
        reminder_disposition_state=(
            None
            if model.reminder_disposition_state is None
            else ReminderDispositionState(model.reminder_disposition_state)
        ),
        deleted_at=model.deleted_at,
    )


def _to_override_snapshot(
    model: ScheduleOccurrenceOverride,
) -> ScheduleOccurrenceOverrideSnapshot:
    """Map one occurrence override row to the shared snapshot contract."""
    return ScheduleOccurrenceOverrideSnapshot(
        id=model.id,
        schedule_id=model.schedule_id,
        occurrence_start=model.occurrence_start,
        action=OccurrenceOverrideAction(model.action),
        replacement_schedule_id=model.replacement_schedule_id,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


__all__ = ["ScheduleRepository", "ScheduleRevisionConflictError"]
