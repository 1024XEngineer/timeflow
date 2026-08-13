import { describe, expect, it, jest } from '@jest/globals';
import * as TaskManager from 'expo-task-manager';

import {
  GEOFENCE_TASK_NAME,
  subscribeGeofenceTaskEvents,
} from '../../../../src/infrastructure/location/geofenceTask';

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
}));

jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
}));

type TaskHandler = (event: {
  data?: { eventType?: number; region?: Record<string, unknown> };
  error?: Error;
}) => Promise<void>;

describe('geofenceTask', () => {
  it('defines the geofence task once and forwards enter/exit events', async () => {
    expect(TaskManager.isTaskDefined).toHaveBeenCalledWith(GEOFENCE_TASK_NAME);
    expect(TaskManager.defineTask).toHaveBeenCalledWith(GEOFENCE_TASK_NAME, expect.any(Function));
    const handler = (TaskManager.defineTask as jest.MockedFunction<typeof TaskManager.defineTask>)
      .mock.calls[0]?.[1] as unknown as TaskHandler;

    const events: unknown[] = [];
    const unsubscribe = subscribeGeofenceTaskEvents((payload) => {
      events.push(payload);
    });

    await handler({ error: new Error('failed') });
    await handler({ data: { eventType: 1 } });
    await handler({
      data: {
        eventType: 1,
        region: {
          identifier: 'schedule-1',
          latitude: 31.23,
          longitude: 121.47,
          radius: 150,
        },
      },
    });
    await handler({
      data: {
        eventType: 2,
        region: {
          identifier: 'schedule-1',
          latitude: 31.23,
          longitude: 121.47,
          radius: 150,
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        schedule_id: 'schedule-1',
        event: 'enter',
        latitude: 31.23,
        longitude: 121.47,
        radius: 150,
      }),
      expect.objectContaining({
        schedule_id: 'schedule-1',
        event: 'exit',
      }),
    ]);
    unsubscribe();
  });
});
