import type { Schedule } from '@/contracts';

export function nextStatusAfterToggle(status: Schedule['status']): Schedule['status'] | null {
  if (status === 'deleted') return null;
  return status === 'done' ? 'scheduled' : 'done';
}

export function markDeleted(schedule: Schedule, systemScheduleRefId: string | null): Schedule {
  return {
    ...schedule,
    status: 'deleted',
    system_schedule_ref_id: systemScheduleRefId,
    updated_at: new Date().toISOString(),
  };
}

export function withStatus(
  schedule: Schedule,
  status: Schedule['status'],
  systemScheduleRefId: string | null,
): Schedule {
  return {
    ...schedule,
    status,
    system_schedule_ref_id: systemScheduleRefId,
    updated_at: new Date().toISOString(),
  };
}
