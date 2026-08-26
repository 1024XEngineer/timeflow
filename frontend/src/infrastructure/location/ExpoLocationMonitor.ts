import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type {
  LocationMonitorEvent,
  LocationMonitorPort,
  LocationRebuildTarget,
  LocationWatchHandle,
  LocationWatchRequest,
} from '../../features/reminder/application/interfaces';
import type { LocationSample } from '../../features/reminder/domain';

import type { LocationProvider } from './LocationProvider';

type ActiveWatch = {
  listener_id: string;
  request: LocationWatchRequest;
  listener: (event: LocationMonitorEvent) => unknown;
};

/**
 * 老版本注册过的系统围栏任务名。代码里已经不再注册它了，但 expo-task-manager 把
 * 注册持久化在 SharedPreferences 里，光删代码清不掉：老装机升级上来之后，那条
 * GMS 围栏会一直挂着，被唤醒时又找不到对应的 JS 任务（logcat 里表现为
 * "Job for task 'timeflow-geofence' has been cancelled by the system"）。所以必须
 * 主动停一次。
 */
const LEGACY_GEOFENCE_TASK_NAME = 'timeflow-geofence';

/**
 * 地点提醒的位置适配器：只负责"记住在盯哪些点"和"取当前位置"，**不做进出判定**。
 *
 * 进出判定统一由 ReminderGuardCoordinator 的常驻前台服务驱动——它每次位置心跳都
 * 调 LocalReminderApplication.handleLocation(sample)，那边遍历所有地点日程逐个跑
 * applyLocationSample()/evaluateGeofence()。这里只在 watch()/rebuild() 时主动取一次
 * 当前定位送出去，让 armed 状态机有个正确的起始值。
 *
 * 为什么删掉了原来的系统原生围栏（expo-location startGeofencingAsync / Android
 * GeofencingClient）——真机排查的结论，三条：
 *
 * 1. 它对判定零贡献。回调进来之后，代码根本不用 GMS 给的 enter/exit 结论，而是
 *    **伪造**一个坐标（enter 用圆心、exit 用圆心外约 1.1km）再喂给同一个
 *    evaluateGeofence 重算。判定逻辑一直是轮询那一套，围栏只是个触发器，而且喂的
 *    是编造的输入而非真实位置。
 * 2. 它主动制造问题。每次日程刷新都会 stop+start 重注册一遍，而 GeofenceRequest 的
 *    initialEventsFilter 含 OUTSIDE，于是每次重注册 GMS 都立刻补投一次"当前在圈外"
 *    （日志里一连串假 exit 事件）；更糟的是重注册会重置 GMS 的围栏状态机，真正
 *    走进围栏的那个 enter 撞在窗口里就丢了。
 * 3. 省电的理由不成立。guard 的前台服务只要还有未完成的提醒就一直在跑（时间型
 *    兜底、卡住补救都靠它），也就是说有地点提醒要看的时候轮询本来就在进行，
 *    砍掉围栏不增加任何功耗。
 *
 * 换来的代价，是明确接受的：**进程连同前台服务一起被系统杀掉之后，没有任何东西
 * 能把我们唤醒，地点提醒到下次启动前不可用。** 原生围栏活在 GMS 系统进程里，本来
 * 能通过 PendingIntent 拉起 JS 引擎——这是它唯一不可替代的价值，现在放弃了。
 *
 * 顺带修掉一个已知陷阱：围栏状态机靠观测到一次"确定在圈外"才武装，依赖 GMS 就
 * 依赖它给出 exit 事件，拿不到就永远不武装、之后再进圈也不响。改成轮询之后每个
 * 心跳都有真实的圈外样本，武装变成必然。
 */
export class ExpoLocationMonitor implements LocationMonitorPort, LocationProvider {
  private readonly watches = new Map<string, ActiveWatch>();
  private readonly scheduleToListener = new Map<string, string>();
  private lastSample: LocationSample | null = null;

  constructor() {
    void cleanUpLegacyGeofencing();
  }

  async watch(
    request: LocationWatchRequest,
    listener: (event: LocationMonitorEvent) => unknown,
  ): Promise<LocationWatchHandle> {
    const existingId = this.scheduleToListener.get(request.schedule_id);
    if (existingId != null) {
      this.removeWatch(existingId);
    }

    const listener_id = `location-${request.schedule_id}`;
    this.watches.set(listener_id, { listener_id, request: { ...request }, listener });
    this.scheduleToListener.set(request.schedule_id, listener_id);

    // 唯一一次主动送样本：给 armed 状态机定起始值。之后的进出全靠 guard 心跳走
    // handleLocation()，不再经过这个 listener。
    const sample = await this.getCurrentSample();
    if (sample != null) {
      await listener({ schedule_id: request.schedule_id, sample });
    }

    return { listener_id, schedule_id: request.schedule_id };
  }

  async unwatch(listenerId: string): Promise<void> {
    this.removeWatch(listenerId);
  }

  async rebuild(
    targets: readonly LocationRebuildTarget[],
    listener: (event: LocationMonitorEvent) => unknown,
  ): Promise<readonly LocationWatchHandle[]> {
    for (const listenerId of [...this.watches.keys()]) {
      this.removeWatch(listenerId);
    }

    // 直接灌 Map，不逐个调用 watch()：watch() 里的 getCurrentSample() 是为单条增量
    // 注册设计的，N 个 target 各跑一次就要打 N 次定位请求。这里全部灌完只取一次
    // 定位，再扇给每个刚注册的 watch。
    const handles: LocationWatchHandle[] = [];
    for (const target of targets) {
      const listener_id = `location-${target.schedule_id}`;
      this.watches.set(listener_id, {
        listener_id,
        request: { schedule_id: target.schedule_id, center: target.center },
        listener,
      });
      this.scheduleToListener.set(target.schedule_id, listener_id);
      handles.push({ listener_id, schedule_id: target.schedule_id });
    }

    const sample = await this.getCurrentSample();
    if (sample != null) {
      for (const handle of handles) {
        await listener({ schedule_id: handle.schedule_id, sample });
      }
    }

    return handles;
  }

  async getLastSample(): Promise<LocationSample | null> {
    return this.lastSample;
  }

  async getCurrentSample(): Promise<LocationSample | null> {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.warn('[location] getCurrentSample skipped: foreground permission not granted');
        return this.lastSample;
      }
      const position = await Location.getCurrentPositionAsync({});
      const sample = toSample(position);
      this.lastSample = sample;
      return sample;
    } catch (error) {
      console.warn('[location] getCurrentSample failed', error);
      return this.lastSample;
    }
  }

  private removeWatch(listenerId: string): void {
    const watch = this.watches.get(listenerId);
    if (watch == null) return;
    this.watches.delete(listenerId);
    this.scheduleToListener.delete(watch.request.schedule_id);
  }
}

/**
 * 停掉老版本留下的系统围栏注册。
 *
 * 不用进程内的 once 标志：两个查询本身就是幂等的（停过一次之后
 * hasStartedGeofencingAsync/isTaskRegisteredAsync 都会返回 false），而生产环境
 * createAppServices() 只跑一次、也就只构造一个 monitor，多出来的两次原生查询可以
 * 忽略。少一个模块级可变状态，换来这段逻辑可以被单测覆盖。
 *
 * 失败即放弃：这是清理旧状态，不是功能路径，任何一步失败都不该影响地点提醒本身
 * （判定全在 guard 心跳那条链上）。
 */
async function cleanUpLegacyGeofencing(): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(LEGACY_GEOFENCE_TASK_NAME)) {
      await Location.stopGeofencingAsync(LEGACY_GEOFENCE_TASK_NAME);
      console.warn('[location] stopped the legacy geofencing registration');
    }
    // stopGeofencingAsync 只解绑围栏本身，任务注册可能还留在 TaskManager 里。
    if (await TaskManager.isTaskRegisteredAsync(LEGACY_GEOFENCE_TASK_NAME)) {
      await TaskManager.unregisterTaskAsync(LEGACY_GEOFENCE_TASK_NAME);
      console.warn('[location] unregistered the legacy geofence task');
    }
  } catch (error) {
    console.warn('[location] legacy geofencing cleanup failed', error);
  }
}

function toSample(position: Location.LocationObject): LocationSample {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_meters: position.coords.accuracy ?? 0,
    observed_at: new Date(position.timestamp).toISOString(),
  };
}
