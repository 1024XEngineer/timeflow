import { describe, expect, it } from '@jest/globals';

import { upsertDraftForSchedule } from '@/features/schedule/data/adapters';
import { makeSchedule } from '@test/fixtures';

describe('upsertDraftForSchedule', () => {
  it('maps schedule fields into a domain draft', () => {
    const schedule = makeSchedule({
      id: 'schedule_42',
      notes: '备注',
      location_name: '办公室',
      location_address: '南京东路1号',
      latitude: 31.2,
      longitude: 121.4,
      geofence_radius_meters: 200,
      geofence_armed: true,
      time_remind_offset_minutes: 10,
    });

    expect(upsertDraftForSchedule(schedule)).toEqual({
      schedule_id: 'schedule_42',
      source_mode: 'manual',
      schedule_type: 'time',
      title: '测试日程',
      notes: '备注',
      start_time: schedule.start_time,
      end_time: null,
      timezone: 'Asia/Shanghai',
      location_name: '办公室',
      location_address: '南京东路1号',
      latitude: 31.2,
      longitude: 121.4,
      geofence_radius_meters: 200,
      geofence_armed: true,
      time_remind_offset_minutes: 10,
    });
  });
});
