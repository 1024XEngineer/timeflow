import { describe, expect, it } from '@jest/globals';

import type {
  LocalReminderSchedule,
  ReminderStrength,
} from '../../../../../src/features/reminder/domain';
import {
  composeReminderSpeech,
  resolveStrengthDeliveryPlan,
} from '../../../../../src/features/reminder/domain/strengthDelivery';

describe('resolveStrengthDeliveryPlan', () => {
  it('low: system notification only, native ring page gets a one-shot ping', () => {
    expect(resolveStrengthDeliveryPlan('low')).toEqual({
      useSystemNotification: true,
      usePopup: false,
      useVibration: false,
      useAudio: false,
      alarmSoundTier: 'ping',
    });
  });

  it('medium: popup + vibration, no JS audio, native ring page gets a one-shot ping', () => {
    expect(resolveStrengthDeliveryPlan('medium')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: false,
      alarmSoundTier: 'ping',
    });
  });

  it('high: popup + vibration + audio, native ring page gets the full looping sound', () => {
    expect(resolveStrengthDeliveryPlan('high')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: true,
      alarmSoundTier: 'full',
    });
  });
});

describe('composeReminderSpeech', () => {
  it('high with a timed start speaks the title and the local clock time', () => {
    // 2026-08-18T10:00:00.000Z == Asia/Shanghai 18:00
    expect(
      composeReminderSpeech(
        speechSchedule('high', ' 九点面试 ', false, '2026-08-18T10:00:00.000Z'),
      ),
    ).toBe('九点面试，时间到了。现在已经18点了。');
  });

  it('high with a non-zero minute includes the minute', () => {
    expect(
      composeReminderSpeech(speechSchedule('high', '拿快递', false, '2026-08-18T10:30:00.000Z')),
    ).toBe('拿快递，时间到了。现在已经18点30分了。');
  });

  it('high all-day schedule speaks the date instead of a clock time', () => {
    expect(
      composeReminderSpeech(speechSchedule('high', '交房租', true, '2026-08-18T10:00:00.000Z')),
    ).toBe('8月18日，今天任务是交房租。');
  });

  it('high with no start_time falls back to a generic prompt', () => {
    expect(composeReminderSpeech(speechSchedule('high', '开会', false, null))).toBe(
      '开会，时间到了，请及时处理。',
    );
  });

  it('high with blank title falls back to a placeholder title', () => {
    expect(composeReminderSpeech(speechSchedule('high', '   ', false, null))).toBe(
      '未命名日程，时间到了，请及时处理。',
    );
  });

  it('non-high returns empty string', () => {
    expect(
      composeReminderSpeech(speechSchedule('medium', '开会', false, '2026-08-18T10:00:00.000Z')),
    ).toBe('');
    expect(
      composeReminderSpeech(speechSchedule('low', '开会', false, '2026-08-18T10:00:00.000Z')),
    ).toBe('');
  });
});

function speechSchedule(
  strength: ReminderStrength,
  title: string,
  isAllDay: boolean,
  startTime: string | null,
): LocalReminderSchedule {
  return {
    id: 's1',
    account_id: 'acc',
    title,
    schedule_type: 'time',
    schedule_kind: 'once',
    is_all_day: isAllDay,
    start_time: startTime,
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 200,
    reminder: {
      reminder_type: 'at_time',
      reminder_trigger_at: null,
      reminder_offset_minutes: null,
      reminder_strength: strength,
    },
    runtime: {
      reminder_disposition_state: null,
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: false,
      disposition_updated_at: null,
      sync_status: 'pending',
      recorded_location: null,
    },
    status: 'active',
    revision: 1,
    cloud_revision: 1,
    updated_at: '2026-08-18T09:00:00.000Z',
  };
}
