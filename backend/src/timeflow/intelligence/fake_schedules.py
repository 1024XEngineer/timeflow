"""A seeded schedule set that answers queries, until the real service exists."""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from timeflow.business.calendar import ScheduleAgentService

logger = logging.getLogger(__name__)

LOCAL = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True, slots=True)
class _Seed:
    """One schedule expressed relative to today, so the set never goes stale."""

    schedule_id: str
    title: str
    day_offset: int
    local_hour: int
    local_minute: int = 0
    location_name: str | None = None
    is_all_day: bool = False
    schedule_kind: str = "once"
    recurrence_rule: str | None = None
    reminder_offset_minutes: int | None = 15

    def start_time(self, today: datetime) -> datetime:
        """Return the absolute start, built in local time then converted to UTC."""
        day = (today.astimezone(LOCAL) + timedelta(days=self.day_offset)).date()
        local = datetime(
            day.year, day.month, day.day, self.local_hour, self.local_minute, tzinfo=LOCAL
        )
        return local.astimezone(UTC)


# Spread deliberately: past and future, near and far, all-day and recurring, repeated and
# unique locations. A query that ignores its criteria returns all of them, which shows.
SEEDS: tuple[_Seed, ...] = (
    _Seed("schedule_past_001", "上周的项目复盘", day_offset=-4, local_hour=16, location_name="203"),
    _Seed("schedule_today_001", "早会", day_offset=0, local_hour=9, location_name="线上"),
    _Seed("schedule_today_002", "健身", day_offset=0, local_hour=19, location_name="健身房"),
    _Seed("schedule_tmr_001", "项目周会", day_offset=1, local_hour=15, location_name="203"),
    _Seed("schedule_tmr_002", "团建", day_offset=1, local_hour=0, is_all_day=True),
    _Seed(
        "schedule_day3_001",
        "牙医复诊",
        day_offset=2,
        local_hour=9,
        local_minute=30,
        location_name="口腔医院",
        reminder_offset_minutes=60,
    ),
    _Seed("schedule_wk2_001", "季度评审", day_offset=9, local_hour=10, location_name="大会议室"),
    _Seed(
        "schedule_rec_001",
        "英语课",
        day_offset=3,
        local_hour=20,
        location_name="线上",
        schedule_kind="recurring",
        recurrence_rule="FREQ=WEEKLY;BYDAY=WE",
    ),
)


class SeededScheduleFinder:
    """Answer queries from a fixed set, honouring the criteria it is given.

    Honouring them is the point: ignored criteria would give every question the same
    answer, and nothing would show whether the model turned "明天" into the right range.
    """

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        """Store the clock seam so tests can pin today."""
        self._now = now or (lambda: datetime.now(UTC))

    async def find(self, account_id: str, criteria: dict[str, Any]) -> list[dict[str, Any]]:
        """Return the schedules matching every supplied criterion."""
        today = self._now()
        after = _parse_time(criteria.get("starts_at_or_after"))
        before = _parse_time(criteria.get("starts_before"))
        title = _clean(criteria.get("title"))
        location = _clean(criteria.get("location_name"))

        found: list[dict[str, Any]] = []
        for seed in SEEDS:
            start = seed.start_time(today)
            if after is not None and start < after:
                continue
            if before is not None and start >= before:
                continue
            if title and title not in seed.title:
                continue
            if location and not _place_matches(location, seed.location_name):
                continue
            found.append(_snapshot(seed, start))

        logger.info(
            "answered a schedule query from seeded data",
            extra={"criteria": criteria, "matched": len(found)},
        )
        return found


def _parse_time(value: Any) -> datetime | None:
    """Parse an ISO-8601 instant, treating an unusable one as no bound at all.

    An empty answer reads as "you have nothing scheduled", which is wrong; a wide one is
    merely unhelpful.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("realtime model sent an unparsable time bound", extra={"value": value})
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=LOCAL)


def _place_matches(wanted: str, stored: str | None) -> bool:
    """Match a place either way round; "203会议室" must find one stored as "203"."""
    if stored is None:
        return False
    return wanted in stored or stored in wanted


def _clean(value: Any) -> str:
    """Return a usable search string, or empty when there is nothing to match on."""
    return value.strip() if isinstance(value, str) else ""


def _snapshot(seed: _Seed, start: datetime) -> dict[str, Any]:
    """Build one schedule snapshot in the shape the protocol sends to clients."""
    return {
        "id": seed.schedule_id,
        "title": seed.title,
        "schedule_type": "time",
        "schedule_kind": seed.schedule_kind,
        "is_all_day": seed.is_all_day,
        "start_time": start.isoformat().replace("+00:00", "Z"),
        "end_time": None,
        "timezone": "Asia/Shanghai",
        "recurrence_rule": seed.recurrence_rule,
        "location_name": seed.location_name,
        "latitude": None,
        "longitude": None,
        "status": "active",
        "reminder_type": "before_start" if seed.reminder_offset_minutes else None,
        "reminder_trigger_at": None,
        "reminder_offset_minutes": seed.reminder_offset_minutes,
        "reminder_strength": "medium" if seed.reminder_offset_minutes else None,
        "reminder_disposition_state": None,
        "revision": 1,
    }


class SeededScheduleService(ScheduleAgentService):
    """In-memory ScheduleAgentService for testing realtime schedule tools."""

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(UTC))
        self._finder = SeededScheduleFinder(now)
        self._next_id = 1000

    def create_schedule(self, *, account_id: str, command: Any) -> Any:
        """Accept a command and produce a mutation result with one schedule."""
        from timeflow.business.calendar import ScheduleMutationResult
        schedule_id = f"schedule_created_{self._next_id}"
        self._next_id += 1
        snapshot = self._command_to_snapshot(schedule_id, command)
        logger.info("created seeded schedule", extra={"schedule_id": schedule_id})
        return ScheduleMutationResult(schedules=(_dict_to_snapshot(snapshot),))

    def find_schedules(self, *, account_id: str, query: Any) -> Any:
        """Delegate to the finder and wrap results in SearchResult."""
        import asyncio

        from timeflow.business.calendar import ScheduleSearchResult
        raw = asyncio.run(self._finder.find(account_id, _query_to_dict(query)))
        snapshots = tuple(_dict_to_snapshot(s) for s in raw)
        return ScheduleSearchResult(schedules=snapshots)

    def update_schedule(self, *, account_id: str, command: Any) -> Any:
        """Accept and apply patch to produce a result."""
        from timeflow.business.calendar import ScheduleMutationResult
        updated = self._command_to_snapshot(command.schedule_id, command)
        logger.info("updated seeded schedule", extra={"schedule_id": command.schedule_id})
        return ScheduleMutationResult(schedules=(_dict_to_snapshot(updated),))

    def delete_once_schedule(self, *, account_id: str, command: Any) -> Any:
        """Mark schedule deleted and return empty result."""
        from timeflow.business.calendar import ScheduleMutationResult
        logger.info("deleted once schedule", extra={"schedule_id": command.schedule_id})
        return ScheduleMutationResult(schedules=())

    def delete_recurring_schedule(self, *, account_id: str, command: Any) -> Any:
        """Mark recurring schedule deleted and return empty result."""
        from timeflow.business.calendar import ScheduleMutationResult
        logger.info("deleted recurring schedule", extra={"schedule_id": command.schedule_id, "scope": command.scope})
        return ScheduleMutationResult(schedules=())

    def _command_to_snapshot(self, schedule_id: str, command: Any) -> dict[str, Any]:
        """Convert command to snapshot dict."""
        return {
            "id": schedule_id,
            "title": getattr(command, "title", "Untitled"),
            "schedule_type": getattr(command, "schedule_type", "time"),
            "schedule_kind": getattr(command, "schedule_kind", "once"),
            "is_all_day": getattr(command, "is_all_day", False),
            "start_time": getattr(command, "start_time", None),
            "end_time": getattr(command, "end_time", None),
            "timezone": getattr(command, "timezone", "Asia/Shanghai"),
            "recurrence_rule": getattr(command, "recurrence_rule", None),
            "location_name": getattr(command, "location_name", None),
            "latitude": getattr(command, "latitude", None),
            "longitude": getattr(command, "longitude", None),
            "status": "active",
            "reminder_type": getattr(command, "reminder_type", None),
            "reminder_trigger_at": getattr(command, "reminder_trigger_at", None),
            "reminder_offset_minutes": getattr(command, "reminder_offset_minutes", None),
            "reminder_strength": getattr(command, "reminder_strength", None),
            "reminder_disposition_state": None,
            "revision": getattr(command, "expected_revision", 0) + 1,
        }


def _query_to_dict(query: Any) -> dict[str, Any]:
    """Convert query object to dict for finder."""
    return {k: v for k, v in query.__dict__.items() if not k.startswith("_")}


def _dict_to_snapshot(d: dict[str, Any]) -> Any:
    """Convert dict to ScheduleSnapshot dataclass."""
    from timeflow.business.calendar import (
        ReminderStrength,
        ReminderType,
        ScheduleKind,
        ScheduleSnapshot,
        ScheduleStatus,
        ScheduleType,
    )
    return ScheduleSnapshot(
        id=d["id"],
        account_id="__seed__",
        title=d["title"],
        schedule_type=ScheduleType(d["schedule_type"]),
        schedule_kind=ScheduleKind(d["schedule_kind"]),
        is_all_day=d["is_all_day"],
        timezone=d["timezone"],
        status=ScheduleStatus(d["status"]),
        revision=d["revision"],
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        start_time=d["start_time"],
        end_time=d["end_time"],
        recurrence_rule=d["recurrence_rule"],
        location_name=d["location_name"],
        latitude=d["latitude"],
        longitude=d["longitude"],
        reminder_type=ReminderType(d["reminder_type"]) if d["reminder_type"] else None,
        reminder_trigger_at=d["reminder_trigger_at"],
        reminder_offset_minutes=d["reminder_offset_minutes"],
        reminder_strength=ReminderStrength(d["reminder_strength"]) if d["reminder_strength"] else None,
        reminder_disposition_state=None,
        deleted_at=None,
    )
