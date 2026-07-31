import type { Schedule } from '@/contracts';

export function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule_test',
    user_id: 'default_user',
    source_mode: 'manual',
    schedule_type: 'time',
    status: 'scheduled',
    title: '测试日程',
    notes: null,
    start_time: new Date(2026, 6, 29, 9, 5).toISOString(),
    end_time: null,
    timezone: 'Asia/Shanghai',
    location_name: null,
    location_address: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 100,
    geofence_armed: false,
    time_remind_offset_minutes: 15,
    time_triggered_at: null,
    geo_triggered_at: null,
    system_schedule_ref_id: null,
    system_alarm_ref_id: null,
    created_at: new Date(2026, 6, 20, 10, 0).toISOString(),
    updated_at: new Date(2026, 6, 20, 10, 0).toISOString(),
    ...overrides,
  };
}
