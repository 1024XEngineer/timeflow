import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';

import type { LocalReminderSchedule } from '../../../../src/features/reminder/domain';
import { NativeLocationMonitor } from '../../../../src/infrastructure/location/NativeLocationMonitor';
import {
  baiduGetCurrentPosition,
  baiduInit,
  baiduStartUpdating,
  baiduStopUpdating,
} from '../../../../src/infrastructure/location/native/BaiduLocationBridge';

type LocationSamplePayload = {
  latitude: number;
  longitude: number;
  accuracy: number;
  observedAt: string;
};

type BaiduBridgeMock = {
  listeners: Set<(sample: LocationSamplePayload) => void>;
  isBaiduLocationAvailable: jest.MockedFunction<() => boolean>;
  baiduInit: jest.MockedFunction<(ak: string | null) => Promise<boolean>>;
  baiduStartUpdating: jest.MockedFunction<(intervalMs: number) => Promise<boolean>>;
  baiduStopUpdating: jest.MockedFunction<() => Promise<void>>;
  baiduGetCurrentPosition: jest.MockedFunction<() => Promise<LocationSamplePayload | null>>;
};

jest.mock('../../../../src/infrastructure/location/native/BaiduLocationBridge', () => {
  const mockListeners = new Set();
  return {
    listeners: mockListeners,
    isBaiduLocationAvailable: jest.fn(() => true),
    baiduInit: jest.fn(async () => true),
    baiduStartUpdating: jest.fn(async () => true),
    baiduStopUpdating: jest.fn(async () => undefined),
    baiduGetCurrentPosition: jest.fn(async () => null),
    subscribeBaiduLocation: (mockListener: unknown) => {
      mockListeners.add(mockListener);
      return () => {
        mockListeners.delete(mockListener);
      };
    },
  };
});

const baidu = jest.requireMock(
  '../../../../src/infrastructure/location/native/BaiduLocationBridge',
) as BaiduBridgeMock;

const CENTER = { latitude: 31.2304, longitude: 121.4737 };
const INSIDE: LocationSamplePayload = {
  latitude: 31.2304,
  longitude: 121.4737,
  accuracy: 8,
  observedAt: '2026-08-13T08:00:00.000Z',
};
const OUTSIDE: LocationSamplePayload = {
  latitude: 31.2324,
  longitude: 121.4737,
  accuracy: 8,
  observedAt: '2026-08-13T08:01:00.000Z',
};

function locationSchedule(id: string): LocalReminderSchedule {
  return {
    id,
    account_id: 'account-a',
    title: '取车',
    schedule_type: 'location',
    schedule_kind: 'once',
    is_all_day: false,
    start_time: null,
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: '停车场',
    latitude: CENTER.latitude,
    longitude: CENTER.longitude,
    geofence_radius_meters: 100,
    reminder: {
      reminder_type: 'arrive_location',
      reminder_trigger_at: null,
      reminder_offset_minutes: null,
      reminder_strength: 'high',
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
    updated_at: '2026-08-13T08:00:00.000Z',
  };
}

describe('NativeLocationMonitor', () => {
  beforeEach(() => {
    baidu.listeners.clear();
    baidu.isBaiduLocationAvailable.mockReturnValue(true);
    baidu.baiduGetCurrentPosition.mockResolvedValue(null);
    baidu.baiduInit.mockClear();
    baidu.baiduStartUpdating.mockClear();
    baidu.baiduStopUpdating.mockClear();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: jest.fn(),
    } as ReturnType<typeof AppState.addEventListener>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts Baidu updates on watch and emits enter/leave phases', async () => {
    const monitor = new NativeLocationMonitor();
    const events: { phase: string }[] = [];
    const handle = await monitor.watch(
      {
        schedule_id: 'schedule-loc',
        center: CENTER,
        radius_meters: 80,
        mode: 'arrive',
        background: true,
      },
      (event) => {
        events.push({ phase: event.phase });
      },
    );

    expect(handle).toEqual({
      listener_id: 'location-schedule-loc',
      schedule_id: 'schedule-loc',
    });
    expect(baiduStartUpdating).toHaveBeenCalledWith(5_000);

    for (const listener of baidu.listeners) listener(INSIDE);
    for (const listener of baidu.listeners) listener(OUTSIDE);

    expect(events).toEqual([{ phase: 'inside' }, { phase: 'left' }]);
    monitor.dispose();
  });

  it('rebuilds watches from location schedules then stops native updates on unwatch', async () => {
    const monitor = new NativeLocationMonitor();
    const handles = await monitor.rebuild(
      [locationSchedule('a'), locationSchedule('b')],
      () => undefined,
    );
    expect(handles).toEqual([
      { listener_id: 'location-a', schedule_id: 'a' },
      { listener_id: 'location-b', schedule_id: 'b' },
    ]);
    expect(baiduStartUpdating).toHaveBeenCalledTimes(1);
    await monitor.unwatch('location-a');
    expect(baiduStopUpdating).not.toHaveBeenCalled();
    await monitor.unwatch('location-b');
    expect(baiduStopUpdating).toHaveBeenCalled();
    monitor.dispose();
  });

  it('does not start native updates when Baidu is unavailable', async () => {
    baidu.isBaiduLocationAvailable.mockReturnValue(false);
    const monitor = new NativeLocationMonitor();
    await monitor.watch(
      {
        schedule_id: 'schedule-loc',
        center: CENTER,
        radius_meters: 80,
        mode: 'arrive',
        background: false,
      },
      () => undefined,
    );
    expect(baidu.baiduStartUpdating).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('maps the current Baidu sample onto LocationSample', async () => {
    baidu.baiduGetCurrentPosition.mockResolvedValue(INSIDE);
    const monitor = new NativeLocationMonitor();
    await expect(monitor.getCurrentSample()).resolves.toEqual({
      latitude: INSIDE.latitude,
      longitude: INSIDE.longitude,
      accuracy_meters: INSIDE.accuracy,
      observed_at: INSIDE.observedAt,
    });
    expect(baiduInit).toHaveBeenCalledWith(null);
    expect(baiduGetCurrentPosition).toHaveBeenCalled();
    monitor.dispose();
  });
});
