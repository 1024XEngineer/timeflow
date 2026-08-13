import { describe, expect, it } from '@jest/globals';
import { waitFor } from '@testing-library/react-native';

import { LocalReminderApplication } from '../../../../src/features/reminder/application/LocalReminderApplication';
import type {
  AlarmNativeEvent,
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
  ReminderApplicationDependencies,
} from '../../../../src/features/reminder/application/interfaces';
import type {
  LocalReminderSchedule,
  ReminderDeliveryRequest,
} from '../../../../src/features/reminder/domain';
import { InMemoryLocalScheduleReader } from '../../../../src/features/reminder/data/local/InMemoryLocalScheduleReader';
import { MemoryReminderStateStore } from '../../../../src/features/reminder/data/local/MemoryReminderStateStore';
import { MockAudioPlayback } from '../../../../src/infrastructure/audio';
import { MockLocationMonitor } from '../../../../src/infrastructure/location';
import {
  MockDeviceCapability,
  MockPopup,
  MockReminderDelivery,
  MockReminderRecovery,
  MockSystemNotification,
  MockVibration,
} from '../../../../src/infrastructure/notifications';
import { MockTimeListener } from '../../../../src/shared/time';

const NOW = '2026-08-13T08:00:00.000Z';
const FUTURE = '2026-08-13T09:00:00.000Z';

const SCHEDULE: LocalReminderSchedule = {
  id: 'schedule-time',
  account_id: 'account-a',
  title: '晨会',
  schedule_type: 'time',
  schedule_kind: 'once',
  is_all_day: false,
  start_time: FUTURE,
  end_time: null,
  timezone: 'Asia/Shanghai',
  recurrence_rule: null,
  location_name: '会议室',
  latitude: null,
  longitude: null,
  geofence_radius_meters: 100,
  reminder: {
    reminder_type: 'at_time',
    reminder_trigger_at: FUTURE,
    reminder_offset_minutes: null,
    reminder_strength: 'medium',
  },
  runtime: {
    reminder_disposition_state: null,
    next_trigger_at: FUTURE,
    snoozed_until: null,
    geofence_armed: false,
    disposition_updated_at: null,
    sync_status: 'pending',
    recorded_location: null,
  },
  status: 'active',
  revision: 1,
  cloud_revision: 1,
  updated_at: NOW,
};

class RecordingPresenter {
  readonly shown: ReminderDeliveryRequest[] = [];

  async show(request: ReminderDeliveryRequest) {
    this.shown.push(request);
    return { presentation_id: 'p1', visible: true };
  }

  async hide(_scheduleId: string) {
    return Promise.resolve();
  }

  onAction() {
    return () => undefined;
  }
}

class FakeAlarms implements AlarmSchedulerPort {
  listener: ((event: AlarmNativeEvent) => void) | null = null;
  stopCount = 0;

  async schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt> {
    return {
      alarm_id: `alarm-${request.schedule_id}`,
      schedule_id: request.schedule_id,
      scheduled: true,
    };
  }

  async cancel(_alarmId: string | null): Promise<{ cancelled: boolean }> {
    return { cancelled: true };
  }

  async rebuild(
    requests: readonly AlarmScheduleRequest[],
  ): Promise<readonly AlarmScheduleReceipt[]> {
    return Promise.all(requests.map((request) => this.schedule(request)));
  }

  async stopRinging(): Promise<void> {
    this.stopCount += 1;
  }

  subscribe(listener: (event: AlarmNativeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async consumeNativeDispositions() {
    return [];
  }
}

function ports(
  schedules: InMemoryLocalScheduleReader,
  alarms: FakeAlarms,
  presenter: RecordingPresenter,
): ReminderApplicationDependencies {
  return {
    schedules,
    time: new MockTimeListener(),
    location: new MockLocationMonitor(),
    alarms,
    delivery: new MockReminderDelivery(),
    audio: new MockAudioPlayback(),
    device: new MockDeviceCapability(),
    presenter,
    systemNotification: new MockSystemNotification(),
    popup: new MockPopup(),
    vibration: new MockVibration(),
    recovery: new MockReminderRecovery(),
    state: new MemoryReminderStateStore(),
    dispositionSync: {
      async submitConfirmed(disposition) {
        return { schedule_id: disposition.schedule_id, accepted: true };
      },
    },
  };
}

describe('LocalReminderApplication native alarm events', () => {
  it('does not show the JS presenter when the native alarm already fired', async () => {
    const schedules = new InMemoryLocalScheduleReader();
    schedules.upsert(SCHEDULE);
    const alarms = new FakeAlarms();
    const presenter = new RecordingPresenter();
    const app = new LocalReminderApplication(ports(schedules, alarms, presenter));

    await app.start();
    expect(alarms.listener).not.toBeNull();

    alarms.listener?.({
      type: 'fired',
      schedule_id: SCHEDULE.id,
      alarm_id: 'alarm-schedule-time',
      title: SCHEDULE.title,
      at: NOW,
    });

    await waitFor(async () => {
      const runtime = await app.dependencies.state.read(SCHEDULE.id);
      expect(runtime?.reminder_disposition_state).toBe('pending');
    });

    await app.handleTime({ observed_at: FUTURE });
    expect(presenter.shown).toEqual([]);
    await app.stop();
  });
});
