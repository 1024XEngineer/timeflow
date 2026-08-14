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

/** 没有订阅者时（App 进程已死，Expo 只把 JS 引擎拉起来跑这一个 headless task，
 * AppRoot/ExpoLocationMonitor 那套 React 生命周期根本没启动）事件会先落这里，等
 * 真正的会话起来后由 drainPendingGeofenceEvents() 取走重放，而不是直接丢掉。 */
const PENDING_EVENTS_KEY = 'timeflow-pending-geofence-events';

/** 订阅系统围栏任务回调；须在应用入口尽早 import 本模块以完成 defineTask。 */
export function subscribeGeofenceTaskEvents(listener: GeofenceTaskListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 懒加载：expo-sqlite/kv-store 的默认导出是模块加载时就构造的单例，顶层 import
 * 会在测试环境（没有真实原生模块）里直接抛错——这个仓库里原生相关的按需依赖
 * 一律走动态 import，参照 ExpoAudioPlayback.ts 的 loadExpoAudio()。 */
async function loadStorage(): Promise<typeof import('expo-sqlite/kv-store').Storage | null> {
  try {
    const mod = await import('expo-sqlite/kv-store');
    return mod.Storage;
  } catch {
    return null;
  }
}

/** 取出并清空 headless 期间攒下的围栏事件；调用方负责按订阅时的逻辑重放它们。 */
export async function drainPendingGeofenceEvents(): Promise<readonly GeofenceTaskPayload[]> {
  const storage = await loadStorage();
  if (storage == null) return [];
  const raw = await storage.getItem(PENDING_EVENTS_KEY);
  if (raw == null) return [];
  await storage.removeItem(PENDING_EVENTS_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeofenceTaskPayload[]) : [];
  } catch {
    return [];
  }
}

async function persistPendingEvent(payload: GeofenceTaskPayload): Promise<void> {
  const storage = await loadStorage();
  if (storage == null) return;
  const raw = await storage.getItem(PENDING_EVENTS_KEY);
  const pending: GeofenceTaskPayload[] = [];
  if (raw != null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) pending.push(...(parsed as GeofenceTaskPayload[]));
    } catch {
      // 上一份坏了就当没有，不阻塞这次事件的持久化。
    }
  }
  pending.push(payload);
  await storage.setItem(PENDING_EVENTS_KEY, JSON.stringify(pending));
}

function emit(payload: GeofenceTaskPayload): void {
  if (listeners.size === 0) {
    void persistPendingEvent(payload);
    return;
  }
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
