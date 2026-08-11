import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  ReminderApplicationResult,
  ReminderSnoozeRequest,
} from '../../application/interfaces';
import type {
  LocalReminderSchedule,
  LocationSample,
  ReminderDeliveryReceipt,
  ReminderRegistration,
  ReminderTrigger,
} from '../../domain';

const MOCK_DELIVERY: ReminderDeliveryReceipt = {
  delivery_id: 'mock-delivery-001',
  schedule_id: 'mock-schedule-time-001',
  delivered_at: '2026-08-07T01:00:00.000Z',
  channels: ['system_notification', 'popup', 'vibration'],
  used_fallback_audio: false,
};

function registrationFor(schedule: LocalReminderSchedule): ReminderRegistration {
  if (schedule.schedule_type === 'location') {
    return {
      schedule_id: schedule.id,
      time_listener_id: null,
      location_listener_id: `mock-location-listener-${schedule.id}`,
      alarm_id: null,
    };
  }

  return {
    schedule_id: schedule.id,
    time_listener_id: `mock-time-listener-${schedule.id}`,
    location_listener_id: null,
    alarm_id: `mock-alarm-${schedule.id}`,
  };
}

/** 真实协调器完成前供应用外壳使用的应用门面。 */
export class MockReminderApplication implements ReminderApplicationPort {
  constructor(readonly dependencies: ReminderApplicationDependencies) {}

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  async register(schedule: LocalReminderSchedule): Promise<ReminderRegistration> {
    return registrationFor(schedule);
  }

  async rebuild(): Promise<readonly ReminderRegistration[]> {
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    return schedules.map(registrationFor);
  }

  async handleTime(_tick: { observed_at: string }): Promise<void> {
    return Promise.resolve();
  }

  async handleLocation(_sample: LocationSample): Promise<void> {
    return Promise.resolve();
  }

  async deliver(trigger: ReminderTrigger): Promise<ReminderDeliveryReceipt> {
    return { ...MOCK_DELIVERY, schedule_id: trigger.schedule_id };
  }

  async confirm(scheduleId: string, confirmedAt: string): Promise<ReminderApplicationResult> {
    return {
      accepted: true,
      schedule_id: scheduleId,
      disposition: {
        schedule_id: scheduleId,
        state: 'confirmed',
        updated_at: confirmedAt,
        snoozed_until: null,
        sync_status: 'pending',
      },
    };
  }

  async snooze(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult> {
    // 确定性 mock：绝对时间原样回传；相对分钟映射到固定 fixture 时刻。
    const snoozed_until =
      'snooze_minutes' in request ? '2026-08-07T01:10:00.000Z' : request.snooze_until;

    return {
      accepted: true,
      schedule_id: request.schedule_id,
      disposition: {
        schedule_id: request.schedule_id,
        state: 'snoozed',
        updated_at: '2026-08-07T01:00:00.000Z',
        snoozed_until,
        sync_status: 'pending',
      },
    };
  }
}
