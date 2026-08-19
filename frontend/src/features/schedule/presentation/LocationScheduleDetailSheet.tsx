import { useState } from 'react';

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
  const [previousSchedule, setPreviousSchedule] = useState<LocationScheduleView | null>(schedule);
  const [lastSchedule, setLastSchedule] = useState<LocationScheduleView | null>(schedule);
  if (schedule !== previousSchedule) {
    setPreviousSchedule(schedule);
    if (schedule) setLastSchedule(schedule);
  }
  const detailSchedule = schedule ?? lastSchedule;
  if (!detailSchedule) return null;

  const location = normalizeDetailText(detailSchedule.locationName);
  const reminder = formatReminderDetail(
    detailSchedule.reminderType,
    detailSchedule.reminderStrength,
  );

  return (
    <ScheduleDetailSheet
      onClose={onClose}
      title={detailSchedule.title}
      visible={schedule !== null}
    >
      {location ? <DetailSection icon="📍" label="地点" primary={location} /> : null}
      {reminder ? (
        <DetailSection
          icon="🔔"
          label="提醒"
          primary={reminder.primary}
          secondary={reminder.secondary}
        />
      ) : null}
      <DetailMeta icon="◎">时区 · {detailSchedule.timezone}</DetailMeta>
    </ScheduleDetailSheet>
  );
}
