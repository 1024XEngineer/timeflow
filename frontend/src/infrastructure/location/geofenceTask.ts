import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const GEOFENCE_TASK_NAME = 'timeflow-geofence';

export type GeofenceTaskPayload = {
  schedule_id: string;
  event: 'enter' | 'exit';
  latitude: number;
  longitude: number;
  radius: number;
  observed_at: string;
};

type GeofenceTaskListener = (payload: GeofenceTaskPayload) => void;

const listeners = new Set<GeofenceTaskListener>();

/** 订阅系统围栏任务回调；须在应用入口尽早 import 本模块以完成 defineTask。 */
export function subscribeGeofenceTaskEvents(listener: GeofenceTaskListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(payload: GeofenceTaskPayload): void {
  for (const listener of listeners) {
    listener(payload);
  }
}

if (!TaskManager.isTaskDefined(GEOFENCE_TASK_NAME)) {
  TaskManager.defineTask(GEOFENCE_TASK_NAME, async ({ data, error }) => {
    if (error) return;

    const payload = data as
      | {
          eventType?: Location.GeofencingEventType;
          region?: Location.LocationRegion;
        }
      | undefined;
    const region = payload?.region;
    if (region?.identifier == null) return;

    const eventType = payload?.eventType;
    const event =
      eventType === Location.GeofencingEventType.Enter
        ? 'enter'
        : eventType === Location.GeofencingEventType.Exit
          ? 'exit'
          : null;
    if (event == null) return;

    emit({
      schedule_id: region.identifier,
      event,
      latitude: region.latitude,
      longitude: region.longitude,
      radius: region.radius,
      observed_at: new Date().toISOString(),
    });
  });
}
