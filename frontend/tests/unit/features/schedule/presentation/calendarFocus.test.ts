import { describe, expect, it } from '@jest/globals';

import { calendarFocusTargetFromCommand } from '../../../../../src/features/schedule/presentation/calendarFocus';

const schedule = {
  id: 'schedule-a',
  schedule_type: 'time',
  schedule_kind: 'once',
  start_time: '2026-08-24T07:00:00Z',
  timezone: 'Asia/Shanghai',
};

describe('calendarFocusTargetFromCommand', () => {
  it('creates a focus target only for an applied create_schedule result', () => {
    expect(
      calendarFocusTargetFromCommand({ operation: 'create_schedule', status: 'applied', schedule }),
    ).toMatchObject({ scheduleId: 'schedule-a', kind: 'time', recurrenceMode: 'once' });
  });

  it.each(['list_schedules', 'update_schedule', 'delete_schedule'])(
    'does not focus after %s even when the result contains a schedule',
    (operation) => {
      expect(calendarFocusTargetFromCommand({ operation, status: 'applied', schedule })).toBeNull();
    },
  );

  it('does not use the plural schedules field for a read result', () => {
    expect(
      calendarFocusTargetFromCommand({
        operation: 'list_schedules',
        status: 'applied',
        schedules: [schedule],
      }),
    ).toBeNull();
  });
});
