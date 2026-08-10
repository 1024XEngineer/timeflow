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

const MOCK_REGISTRATION: ReminderRegistration = {
  schedule_id: 'mock-schedule-time-001',
  time_listener_id: 'mock-time-listener-001',
  location_listener_id: null,
  alarm_id: 'mock-alarm-001',
};

const MOCK_LOCATION_REGISTRATION: ReminderRegistration = {
  schedule_id: 'mock-schedule-location-001',
  time_listener_id: null,
  location_listener_id: 'mock-location-listener-001',
  alarm_id: null,
};

const MOCK_DELIVERY: ReminderDeliveryReceipt = {
  delivery_id: 'mock-delivery-001',
  schedule_id: 'mock-schedule-time-001',
  delivered_at: '2026-08-07T01:00:00.000Z',
  channels: ['system_notification', 'popup', 'vibration'],
  used_fallback_audio: false,
};

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
    const fixture =
      schedule.schedule_type === 'location' ? MOCK_LOCATION_REGISTRATION : MOCK_REGISTRATION;
    return { ...fixture, schedule_id: schedule.id };
  }

  async rebuild(): Promise<readonly ReminderRegistration[]> {
    return [MOCK_REGISTRATION, MOCK_LOCATION_REGISTRATION];
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
    return {
      accepted: true,
      schedule_id: request.schedule_id,
      disposition: {
        schedule_id: request.schedule_id,
        state: 'snoozed',
        updated_at: '2026-08-07T01:00:00.000Z',
        snoozed_until: request.snooze_until,
        sync_status: 'pending',
      },
    };
  }
}
