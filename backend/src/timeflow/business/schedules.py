"""Schedule commands, queries, and application service."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_USER_ID = "default_user"
DEFAULT_GEOFENCE_RADIUS_METERS = 100
DEFAULT_TIME_REMIND_OFFSET_MINUTES = 15

SourceMode = Literal["manual", "voice"]
ScheduleType = Literal["time", "location"]
ScheduleStatus = Literal["scheduled", "done", "deleted"]


class ScheduleValidationError(ValueError):
    """Raised when a schedule command or query breaks business rules."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(reason)
        self.field = field
        self.reason = reason


class ScheduleNotFoundError(LookupError):
    """Raised when an update targets a missing schedule."""


@dataclass(frozen=True, slots=True)
class ScheduleRecord:
    """A persisted schedule DTO owned by the business layer."""

    id: str
    user_id: str
    source_mode: SourceMode
    schedule_type: ScheduleType
    status: ScheduleStatus
    title: str
    notes: str | None
    start_time: str | None
    end_time: str | None
    timezone: str | None
    location_name: str | None
    location_address: str | None
    latitude: float | None
    longitude: float | None
    geofence_radius_meters: int
    geofence_armed: bool
    time_remind_offset_minutes: int
    time_triggered_at: str | None
    geo_triggered_at: str | None
    system_schedule_ref_id: str | None
    system_alarm_ref_id: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class ScheduleConflict:
    """A conflicting existing schedule summary."""

    schedule_id: str
    title: str
    start_time: str
    end_time: str | None


@dataclass(frozen=True, slots=True)
class ScheduleUpsertCommand:
    """Create or update a schedule."""

    schedule_id: str | None
    source_mode: str
    schedule_type: str
    title: str
    notes: str | None
    start_time: str | None
    end_time: str | None
    timezone: str | None
    location_name: str | None
    location_address: str | None
    latitude: float | None
    longitude: float | None
    geofence_radius_meters: int | None
    geofence_armed: bool | None
    time_remind_offset_minutes: int | None


@dataclass(frozen=True, slots=True)
class ScheduleUpsertResult:
    """Result returned after create or update."""

    schedule: ScheduleRecord
    schedule_id: str
    schedule_type: ScheduleType
    status: ScheduleStatus
    conflicts: tuple[ScheduleConflict, ...]
    geofence_armed: bool


@dataclass(frozen=True, slots=True)
class ScheduleListQuery:
    """Query schedules visible to the current user."""

    status: str | None
    include_deleted: bool


@dataclass(frozen=True, slots=True)
class ScheduleListResult:
    """List query result."""

    schedules: tuple[ScheduleRecord, ...]


class ScheduleRepository(Protocol):
    """Persistence capability required by the schedule service."""

    def get(self, schedule_id: str, user_id: str) -> ScheduleRecord | None:
        """Return one schedule for a user."""

    def save(self, schedule: ScheduleRecord) -> None:
        """Persist a schedule."""

    def find_time_conflicts(
        self,
        *,
        user_id: str,
        start_time: str,
        end_time: str | None,
        exclude_schedule_id: str | None,
    ) -> Sequence[ScheduleConflict]:
        """Return existing schedules that overlap the requested time."""

    def list(
        self,
        *,
        user_id: str,
        status: ScheduleStatus | None,
        include_deleted: bool,
    ) -> Sequence[ScheduleRecord]:
        """Return schedules sorted for frontend display."""


class ScheduleService:
    """Application service for schedule write and read use cases."""

    def __init__(
        self,
        repository: ScheduleRepository,
        *,
        user_id: str = DEFAULT_USER_ID,
        id_factory: Callable[[], str] | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self._repository = repository
        self._user_id = user_id
        self._id_factory = id_factory or self._default_id_factory
        self._now_provider = now_provider or self._default_now_provider

    def upsert(self, command: ScheduleUpsertCommand) -> ScheduleUpsertResult:
        """Create or update a schedule and return non-blocking conflict hints."""
        source_mode = self._validate_source_mode(command.source_mode)
        schedule_type = self._validate_schedule_type(command.schedule_type)
        title = self._require_text(command.title, "title")
        timezone = self._validate_timezone(command.timezone)
        start_time, start_datetime = self._normalize_datetime(
            command.start_time,
            timezone,
            "start_time",
        )
        end_time, end_datetime = self._normalize_datetime(
            command.end_time,
            timezone,
            "end_time",
        )
        latitude = self._validate_latitude(command.latitude)
        longitude = self._validate_longitude(command.longitude)
        self._validate_type_requirements(schedule_type, start_time, latitude, longitude)
        self._validate_time_range(start_datetime, end_datetime)

        existing = self._load_existing(command.schedule_id)
        schedule_id = existing.id if existing is not None else self._id_factory()
        now = self._normalize_system_time(self._now_provider())
        geofence_armed = (
            command.geofence_armed
            if command.geofence_armed is not None
            else latitude is not None and longitude is not None
        )

        conflicts: tuple[ScheduleConflict, ...] = ()
        if start_time is not None:
            conflicts = tuple(
                self._repository.find_time_conflicts(
                    user_id=self._user_id,
                    start_time=start_time,
                    end_time=end_time,
                    exclude_schedule_id=schedule_id,
                )
            )

        schedule = ScheduleRecord(
            id=schedule_id,
            user_id=self._user_id,
            source_mode=source_mode,
            schedule_type=schedule_type,
            status="scheduled",
            title=title,
            notes=self._optional_text(command.notes),
            start_time=start_time,
            end_time=end_time,
            timezone=timezone,
            location_name=self._optional_text(command.location_name),
            location_address=self._optional_text(command.location_address),
            latitude=latitude,
            longitude=longitude,
            geofence_radius_meters=self._positive_int_or_default(
                command.geofence_radius_meters,
                DEFAULT_GEOFENCE_RADIUS_METERS,
                "geofence_radius_meters",
            ),
            geofence_armed=geofence_armed,
            time_remind_offset_minutes=self._nonnegative_int_or_default(
                command.time_remind_offset_minutes,
                DEFAULT_TIME_REMIND_OFFSET_MINUTES,
                "time_remind_offset_minutes",
            ),
            time_triggered_at=existing.time_triggered_at if existing else None,
            geo_triggered_at=existing.geo_triggered_at if existing else None,
            system_schedule_ref_id=existing.system_schedule_ref_id if existing else None,
            system_alarm_ref_id=existing.system_alarm_ref_id if existing else None,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        self._repository.save(schedule)
        return ScheduleUpsertResult(
            schedule=schedule,
            schedule_id=schedule.id,
            schedule_type=schedule.schedule_type,
            status=schedule.status,
            conflicts=conflicts,
            geofence_armed=schedule.geofence_armed,
        )

    def list(self, query: ScheduleListQuery) -> ScheduleListResult:
        """Return schedules for the current user."""
        status = self._validate_optional_status(query.status)
        if status == "deleted" and not query.include_deleted:
            return ScheduleListResult(schedules=())
        schedules = self._repository.list(
            user_id=self._user_id,
            status=status,
            include_deleted=query.include_deleted,
        )
        return ScheduleListResult(schedules=tuple(schedules))

    def delete(self, schedule_id: str) -> None:
        """标记日程为已删除,清空系统日历/闹钟关联;不做取消监听/终止提醒的特殊处理——
        状态一变,现有的 status == "scheduled" 过滤条件自然会排除它。"""
        normalized_id = self._require_text(schedule_id, "schedule_id")
        existing = self._repository.get(normalized_id, self._user_id)
        if existing is None:
            raise ScheduleNotFoundError(f"schedule not found: {normalized_id}")
        now = self._normalize_system_time(self._now_provider())
        deleted = replace(
            existing,
            status="deleted",
            system_schedule_ref_id=None,
            system_alarm_ref_id=None,
            updated_at=now,
        )
        self._repository.save(deleted)

    def _load_existing(self, schedule_id: str | None) -> ScheduleRecord | None:
        if schedule_id is None:
            return None
        normalized_id = self._require_text(schedule_id, "schedule_id")
        existing = self._repository.get(normalized_id, self._user_id)
        if existing is None:
            raise ScheduleNotFoundError(f"schedule not found: {normalized_id}")
        return existing

    @staticmethod
    def _default_id_factory() -> str:
        return f"schedule_{uuid4().hex}"

    @staticmethod
    def _default_now_provider() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _validate_source_mode(value: str) -> SourceMode:
        if value in {"manual", "voice"}:
            return value  # type: ignore[return-value]
        raise ScheduleValidationError("source_mode", "source_mode must be manual or voice")

    @staticmethod
    def _validate_schedule_type(value: str) -> ScheduleType:
        if value in {"time", "location"}:
            return value  # type: ignore[return-value]
        raise ScheduleValidationError("schedule_type", "schedule_type must be time or location")

    @staticmethod
    def _validate_optional_status(value: str | None) -> ScheduleStatus | None:
        if value is None:
            return None
        if value in {"scheduled", "done", "deleted"}:
            return value  # type: ignore[return-value]
        raise ScheduleValidationError("status", "status must be scheduled, done, or deleted")

    @classmethod
    def _validate_type_requirements(
        cls,
        schedule_type: ScheduleType,
        start_time: str | None,
        latitude: float | None,
        longitude: float | None,
    ) -> None:
        if schedule_type == "time" and start_time is None:
            raise ScheduleValidationError(
                "start_time",
                "schedule_type 为 time 时 start_time 必填",
            )
        if schedule_type == "location" and (latitude is None or longitude is None):
            raise ScheduleValidationError(
                "schedule_type",
                "schedule_type 为 location 时 latitude 和 longitude 必填",
            )
        if schedule_type == "location" and start_time is not None:
            raise ScheduleValidationError(
                "schedule_type",
                "同时填写时间和地点时 schedule_type 应为 time",
            )

    @staticmethod
    def _validate_time_range(
        start_time: datetime | None,
        end_time: datetime | None,
    ) -> None:
        if end_time is not None and start_time is None:
            raise ScheduleValidationError("end_time", "end_time requires start_time")
        if start_time is not None and end_time is not None and end_time < start_time:
            raise ScheduleValidationError(
                "end_time",
                "end_time must be greater than or equal to start_time",
            )

    @classmethod
    def _validate_timezone(cls, value: str | None) -> str | None:
        timezone = cls._optional_text(value)
        if timezone is None:
            return None
        try:
            ZoneInfo(timezone)
        except ZoneInfoNotFoundError as exc:
            raise ScheduleValidationError(
                "timezone",
                "timezone must be a valid IANA timezone",
            ) from exc
        return timezone

    @classmethod
    def _normalize_datetime(
        cls,
        value: str | None,
        timezone: str | None,
        field: str,
    ) -> tuple[str | None, datetime | None]:
        normalized = cls._optional_text(value)
        if normalized is None:
            return None, None
        if "T" not in normalized:
            raise ScheduleValidationError(field, f"{field} must be an ISO-8601 datetime")

        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ScheduleValidationError(
                field,
                f"{field} must be an ISO-8601 datetime",
            ) from exc

        if parsed.tzinfo is None or parsed.utcoffset() is None:
            if timezone is None:
                raise ScheduleValidationError(
                    "timezone",
                    f"timezone is required when {field} has no UTC offset",
                )
            parsed = parsed.replace(tzinfo=ZoneInfo(timezone))

        utc_value = parsed.astimezone(UTC)
        return utc_value.isoformat(timespec="seconds"), utc_value

    @staticmethod
    def _normalize_system_time(value: datetime) -> str:
        if value.tzinfo is None or value.utcoffset() is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat(timespec="seconds")

    @staticmethod
    def _require_text(value: str | None, field: str) -> str:
        if value is None:
            raise ScheduleValidationError(field, f"{field} is required")
        stripped = value.strip()
        if not stripped:
            raise ScheduleValidationError(field, f"{field} is required")
        return stripped

    @staticmethod
    def _optional_text(value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @staticmethod
    def _validate_latitude(value: float | None) -> float | None:
        if value is None:
            return None
        if not -90 <= value <= 90:
            raise ScheduleValidationError("latitude", "latitude must be between -90 and 90")
        return value

    @staticmethod
    def _validate_longitude(value: float | None) -> float | None:
        if value is None:
            return None
        if not -180 <= value <= 180:
            raise ScheduleValidationError("longitude", "longitude must be between -180 and 180")
        return value

    @staticmethod
    def _positive_int_or_default(value: int | None, default: int, field: str) -> int:
        result = default if value is None else value
        if result <= 0:
            raise ScheduleValidationError(field, f"{field} must be greater than 0")
        return result

    @staticmethod
    def _nonnegative_int_or_default(value: int | None, default: int, field: str) -> int:
        result = default if value is None else value
        if result < 0:
            raise ScheduleValidationError(field, f"{field} must be nonnegative")
        return result


__all__ = [
    "DEFAULT_GEOFENCE_RADIUS_METERS",
    "DEFAULT_TIME_REMIND_OFFSET_MINUTES",
    "DEFAULT_USER_ID",
    "ScheduleConflict",
    "ScheduleListQuery",
    "ScheduleListResult",
    "ScheduleNotFoundError",
    "ScheduleRecord",
    "ScheduleRepository",
    "ScheduleService",
    "ScheduleStatus",
    "ScheduleType",
    "ScheduleUpsertCommand",
    "ScheduleUpsertResult",
    "ScheduleValidationError",
    "SourceMode",
]
