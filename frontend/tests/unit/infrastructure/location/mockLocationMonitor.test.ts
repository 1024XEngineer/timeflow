import { describe, expect, it, jest } from '@jest/globals';

import { MockLocationMonitor } from '../../../../src/infrastructure/location/MockLocationMonitor';

describe('MockLocationMonitor', () => {
  it('watch() resolves a handle keyed off the request schedule_id', async () => {
    const monitor = new MockLocationMonitor();
    const handle = await monitor.watch(
      {
        schedule_id: 's1',
        center: { latitude: 1, longitude: 2 },
        radius_meters: 100,
        mode: 'arrive',
        background: false,
      },
      jest.fn(),
    );
    expect(handle).toEqual({ listener_id: 'mock-location-listener-s1', schedule_id: 's1' });
  });

  it('unwatch() resolves without needing a matching watch()', async () => {
    const monitor = new MockLocationMonitor();
    await expect(monitor.unwatch('unknown-listener')).resolves.toBeUndefined();
  });

  it('rebuild() maps each target straight to a handle, no filtering', async () => {
    const monitor = new MockLocationMonitor();
    const handles = await monitor.rebuild(
      [
        {
          schedule_id: 's1',
          center: { latitude: 1, longitude: 2 },
          radius_meters: 100,
          mode: 'arrive',
          background: false,
        },
        {
          schedule_id: 's2',
          center: { latitude: 3, longitude: 4 },
          radius_meters: 200,
          mode: 'return',
          background: true,
        },
      ],
      jest.fn(),
    );
    expect(handles).toEqual([
      { listener_id: 'mock-location-listener-s1', schedule_id: 's1' },
      { listener_id: 'mock-location-listener-s2', schedule_id: 's2' },
    ]);
  });

  it('rebuild() resolves an empty list for no targets', async () => {
    const monitor = new MockLocationMonitor();
    await expect(monitor.rebuild([], jest.fn())).resolves.toEqual([]);
  });

  it('getLastSample()/getCurrentSample() resolve the fixed mock sample', async () => {
    const monitor = new MockLocationMonitor();
    const sample = { latitude: 31.2304, longitude: 121.4737, accuracy_meters: 12 };
    await expect(monitor.getLastSample()).resolves.toMatchObject(sample);
    await expect(monitor.getCurrentSample()).resolves.toMatchObject(sample);
  });
});
