import type { LocationScheduleView } from '../application';
import {
  DetailMeta,
  DetailSection,
  formatReminderDetail,
  normalizeDetailText,
  ScheduleDetailSheet,
} from './ScheduleDetailSheet';

export function LocationScheduleDetailSheet({
  schedule,
  onClose,
}: {
  schedule: LocationScheduleView | null;
  onClose: () => void;
}) {
  if (!schedule) {
    return null;
  }

  const location = normalizeDetailText(schedule.locationName);
  const reminder = formatReminderDetail(schedule.reminderType, schedule.reminderStrength);

  return (
    <ScheduleDetailSheet badges={['地点日程']} onClose={onClose} title={schedule.title}>
      {location ? <DetailSection icon="📍" label="地点" primary={location} /> : null}
      {reminder ? (
        <DetailSection
          icon="🔔"
          label="提醒"
          primary={reminder.primary}
          secondary={reminder.secondary}
        />
      ) : null}
      <DetailMeta icon="◎">时区 · {schedule.timezone}</DetailMeta>
    </ScheduleDetailSheet>
  );
}
