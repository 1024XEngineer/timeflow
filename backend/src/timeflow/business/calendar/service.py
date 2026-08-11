"""Agent-facing schedule application service skeleton."""

from abc import ABC, abstractmethod

from timeflow.business.calendar.contracts import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    ScheduleMutationResult,
    ScheduleSearchResult,
    UpdateScheduleCommand,
)


class ScheduleAgentService(ABC):
    """Five stable schedule operations exposed to the Agent.

    This abstract class intentionally contains no persistence, validation,
    recurrence expansion, or mutation logic yet.
    """

    @abstractmethod
    def create_schedule(
        self,
        *,
        account_id: str,
        command: CreateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Create an ordinary or recurring schedule from a confirmed command.

        Raises:
            ScheduleBusinessError: If the confirmed command is invalid.
        """
        # TODO(person-2): validate the aggregate and persist it transactionally.
        raise NotImplementedError

    @abstractmethod
    def find_schedules(
        self,
        *,
        account_id: str,
        query: FindSchedulesQuery,
    ) -> ScheduleSearchResult:
        """Find schedules for Agent queries, matching, and disambiguation.

        Raises:
            ScheduleBusinessError: If the query contains invalid criteria.
        """
        # TODO(person-2): implement account-scoped schedule matching.
        raise NotImplementedError

    @abstractmethod
    def update_schedule(
        self,
        *,
        account_id: str,
        command: UpdateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Update one schedule; recurring changes apply to the complete series.

        Raises:
            ScheduleBusinessError: If the target, revision, or patch is invalid.
        """
        # TODO(person-2): validate the patch, revision, and final aggregate.
        raise NotImplementedError

    @abstractmethod
    def delete_once_schedule(
        self,
        *,
        account_id: str,
        command: DeleteOnceScheduleCommand,
    ) -> ScheduleMutationResult:
        """Soft-delete one non-recurring schedule.

        Raises:
            ScheduleBusinessError: If the target or revision is invalid.
        """
        # TODO(person-2): validate the target and create a deleted cloud snapshot.
        raise NotImplementedError

    @abstractmethod
    def delete_recurring_schedule(
        self,
        *,
        account_id: str,
        command: DeleteRecurringScheduleCommand,
    ) -> ScheduleMutationResult:
        """Apply the confirmed occurrence, future, or entire-series deletion scope.

        Raises:
            ScheduleBusinessError: If the target, revision, or occurrence is invalid.
        """
        # TODO(person-2): resolve the current occurrence when the confirmed
        # scope requires one, then apply command.scope transactionally.
        raise NotImplementedError


__all__ = ["ScheduleAgentService"]
