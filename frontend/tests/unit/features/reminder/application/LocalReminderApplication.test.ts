import { describe, expect, it, jest } from '@jest/globals';

import { LocalReminderApplication } from '../../../../../src/features/reminder/application/LocalReminderApplication';
import type {
  AlarmNativeDisposition,
  AlarmNativeEvent,
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
  LocationMonitorEvent,
  LocationRebuildTarget,
  LocationWatchRequest,
  PopupRequest,
  ReminderApplicationDependencies,
  ReminderConfirmedDisposition,
  ReminderDeliveryRequest,
  SystemNotificationRequest,
} from '../../../../../src/features/reminder/application/interfaces';
import { MemoryReminderStateStore } from '../../../../../src/features/reminder/data/local/MemoryReminderStateStore';
import type {
  LocalReminderSchedule,
  ReminderRuntimeState,
  ReminderStrength,
} from '../../../../../src/features/reminder/domain';
import type {
  ClientTelemetryPort,
  DeviceTelemetryContext,
  ReminderDeliveryTelemetry,
  ReminderLifecycleTelemetry,
  ReminderNativeBackgroundTelemetry,
  ReminderPermissionBlockedTelemetry,
  TelemetryAppState,
} from '../../../../../src/shared/observability';

/** 事件订阅回调是 fire-and-forget（void handleNativeAlarmEvent(event)），背后
 * 排了好几层 await（enqueueOp → teardownDelivery 的 6 个串行任务 → state 读写
 * → 按需重排闹钟）；固定多轮 flush 比猜一两次够不够稳。 */
async function flushAsync(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

function emptyRuntime(): ReminderRuntimeState {
  return {
    reminder_disposition_state: null,
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: false,
    disposition_updated_at: null,
    sync_status: 'pending',
    recorded_location: null,
  };
}

function fixtureSchedule(overrides: Partial<LocalReminderSchedule> = {}): LocalReminderSchedule {
  return {
    id: 's1',
    account_id: 'acc_1',
    title: '喝水提醒',
    schedule_type: 'time',
    schedule_kind: 'once',
    is_all_day: false,
    start_time: '2026-08-18T10:00:00.000Z',
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 200,
    reminder: {
      reminder_type: 'at_time',
      reminder_trigger_at: '2026-08-18T10:00:00.000Z',
      reminder_offset_minutes: null,
      reminder_strength: 'medium',
    },
    runtime: emptyRuntime(),
    status: 'active',
    revision: 1,
    cloud_revision: 1,
    updated_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

class FakeScheduleReader {
  schedules: LocalReminderSchedule[];
  private readonly listeners = new Set<(schedules: readonly LocalReminderSchedule[]) => void>();

  constructor(schedules: LocalReminderSchedule[] = []) {
    this.schedules = schedules;
  }

  async listReminderSchedules(): Promise<readonly LocalReminderSchedule[]> {
    return this.schedules;
  }

  async getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null> {
    return this.schedules.find((schedule) => schedule.id === scheduleId) ?? null;
  }

  subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function createFakeAlarms(overrides: Partial<AlarmSchedulerPort> = {}) {
  const scheduleCalls: AlarmScheduleRequest[] = [];
  const cancelCalls: (string | null)[] = [];
  let nextId = 0;

  const base: AlarmSchedulerPort = {
    schedule: jest.fn(async (request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt> => {
      scheduleCalls.push(request);
      nextId += 1;
      return { alarm_id: `alarm-${nextId}`, schedule_id: request.schedule_id, scheduled: true };
    }),
    cancel: jest.fn(async (alarmId: string | null) => {
      cancelCalls.push(alarmId);
      return { cancelled: true };
    }),
    rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) =>
      Promise.all(requests.map((request) => base.schedule(request))),
    ),
    peekNativeDispositions: jest.fn(async () => []),
    ackNativeDispositions: jest.fn(async () => {}),
    peekNativeFireAttempts: jest.fn(async () => []),
    ackNativeFireAttempts: jest.fn(async () => {}),
    ...overrides,
  };

  return { alarms: base, cancelCalls, scheduleCalls };
}

function createDeps(
  overrides: Partial<ReminderApplicationDependencies> = {},
): ReminderApplicationDependencies {
  const { alarms } = createFakeAlarms();
  return {
    alarms,
    audio: {
      isTtsAvailable: jest.fn(async () => false),
      playLocalFallback: jest.fn(async () => ({
        playback_id: 'p1',
        played: false,
        used_local_fallback: true,
      })),
      playTts: jest.fn(async () => ({
        playback_id: 'p1',
        played: false,
        used_local_fallback: false,
      })),
      stop: jest.fn(async () => {}),
    },
    delivery: {
      deliver: jest.fn(async (request: ReminderDeliveryRequest) => ({
        delivery_id: `delivery-${request.schedule_id}`,
        schedule_id: request.schedule_id,
        delivered_at: request.trigger.triggered_at,
        channels: [],
        used_fallback_audio: false,
      })),
      dismiss: jest.fn(async () => {}),
    },
    device: {
      getStatus: jest.fn(async () => ({
        platform: 'android' as const,
        supported: true,
        permissions: {
          notifications: true,
          exact_alarm: true,
          overlay: true,
          full_screen: true,
          battery_optimization: true,
          location_foreground: true,
          location_background: true,
          microphone: true,
        },
        background_execution: true,
        oemGuidance: {
          manufacturer: null,
          autostartGuided: false,
          backgroundPopupGuided: false,
          lastOverlayFailed: false,
        },
      })),
      onAppActive: jest.fn(() => () => {}),
      openOemSettings: jest.fn(async () => true),
      openSettings: jest.fn(async () => true),
      requestPermission: jest.fn(async () => true),
    },
    dispositionSync: {
      submitConfirmed: jest.fn(async (disposition: ReminderConfirmedDisposition) => ({
        schedule_id: disposition.schedule_id,
        accepted: true,
      })),
    },
    location: {
      getLastSample: jest.fn(async () => null),
      rebuild: jest.fn(async () => []),
      unwatch: jest.fn(async () => {}),
      watch: jest.fn(async (request: LocationWatchRequest) => ({
        listener_id: `loc-${request.schedule_id}`,
        schedule_id: request.schedule_id,
      })),
    },
    popup: {
      dismiss: jest.fn(async () => {}),
      show: jest.fn(async (request: PopupRequest) => ({
        popup_id: request.popup_id,
        visible: true,
      })),
    },
    presenter: {
      hide: jest.fn(async () => {}),
      onAction: jest.fn(() => () => {}),
      show: jest.fn(async () => ({ presentation_id: 'p1', visible: true })),
    },
    recovery: {
      registerForRestart: jest.fn(async () => ({ registered: true, recovery_id: 'r1' })),
      restoreAfterRestart: jest.fn(async () => ({ registered: true, recovery_id: 'r1' })),
    },
    schedules: new FakeScheduleReader([]),
    state: new MemoryReminderStateStore(),
    systemNotification: {
      cancel: jest.fn(async () => {}),
      show: jest.fn(async (request: SystemNotificationRequest) => ({
        notification_id: request.notification_id,
        shown: true,
      })),
    },
    time: {
      start: jest.fn(async () => ({ listener_id: 'time-1' })),
      stop: jest.fn(async () => {}),
    },
    vibration: {
      stop: jest.fn(async () => {}),
      vibrate: jest.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('LocalReminderApplication', () => {
  describe('cold start: peek/ack native dispositions', () => {
    it('acks the native buffer only after the whole batch of rows persists successfully', async () => {
      const disposition: AlarmNativeDisposition = {
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        state: 'confirmed',
        updated_at: '2026-08-18T09:30:00.000Z',
      };
      const { alarms } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [disposition]),
      });
      const deps = createDeps({ alarms });
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(alarms.peekNativeDispositions).toHaveBeenCalledTimes(1);
      expect(alarms.ackNativeDispositions).toHaveBeenCalledWith(['s1']);
      const ackOrder = (alarms.ackNativeDispositions as jest.Mock).mock.invocationCallOrder[0];
      const submitOrder = (deps.dispositionSync.submitConfirmed as jest.Mock).mock
        .invocationCallOrder[0];
      expect(ackOrder).toBeGreaterThan(submitOrder as number);
    });

    it('acks locally persisted rows when cloud sync remains pending', async () => {
      const rows: AlarmNativeDisposition[] = [
        {
          schedule_id: 's1',
          alarm_id: 'alarm-1',
          state: 'confirmed',
          updated_at: '2026-08-18T09:00:00.000Z',
        },
        {
          schedule_id: 's2',
          alarm_id: 'alarm-2',
          state: 'confirmed',
          updated_at: '2026-08-18T09:01:00.000Z',
        },
      ];
      const { alarms } = createFakeAlarms({ peekNativeDispositions: jest.fn(async () => rows) });
      const deps = createDeps({
        alarms,
        dispositionSync: {
          submitConfirmed: jest.fn(async (disposition: ReminderConfirmedDisposition) => {
            if (disposition.schedule_id === 's2') throw new Error('sync failed');
            return { schedule_id: disposition.schedule_id, accepted: true };
          }),
        },
      });
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(alarms.ackNativeDispositions).toHaveBeenCalledWith(['s1', 's2']);
      await expect(deps.state.read('s2')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
        sync_status: 'pending',
      });
    });

    it('does nothing when the native buffer has no pending rows', async () => {
      const { alarms } = createFakeAlarms({ peekNativeDispositions: jest.fn(async () => []) });
      const deps = createDeps({ alarms });
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(alarms.ackNativeDispositions).not.toHaveBeenCalled();
    });
  });

  describe('confirmed/snoozed/fired hydration', () => {
    it('hydrates a confirmed row into a synced confirmed disposition', async () => {
      const disposition: AlarmNativeDisposition = {
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        state: 'confirmed',
        updated_at: '2026-08-18T09:30:00.000Z',
      };
      const { alarms } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [disposition]),
      });
      const deps = createDeps({ alarms });
      const app = new LocalReminderApplication(deps);

      await app.start();

      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
        next_trigger_at: null,
      });
      expect(deps.dispositionSync.submitConfirmed).toHaveBeenCalledWith(
        expect.objectContaining({ schedule_id: 's1', state: 'confirmed' }),
      );
    });

    it('hydrates a snoozed row and reschedules the native alarm at snoozed_until', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const disposition: AlarmNativeDisposition = {
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        state: 'snoozed',
        updated_at: '2026-08-18T09:30:00.000Z',
      };
      const { alarms, scheduleCalls } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [disposition]),
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);

      await app.start();

      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'snoozed',
      });
      // hydrate 之后 startInternal() 还会跑一次完整 rebuild，两边都会按当前
      // snoozed_until 排闹钟，不只看第一次——只要最终排的时间点对就行。
      expect(scheduleCalls.length).toBeGreaterThan(0);
      for (const call of scheduleCalls) {
        expect(call.schedule_id).toBe('s1');
      }
    });

    it('hydrates a fired (pending) row without syncing yet, marking it native-presented', async () => {
      const disposition: AlarmNativeDisposition = {
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        state: 'pending',
        updated_at: '2026-08-18T09:30:00.000Z',
      };
      const { alarms } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [disposition]),
      });
      const deps = createDeps({ alarms });
      const app = new LocalReminderApplication(deps);

      await app.start();

      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'pending',
        next_trigger_at: null,
      });
      expect(deps.dispositionSync.submitConfirmed).not.toHaveBeenCalled();
    });
  });

  describe('native/JS dual-channel race', () => {
    it('does not double-process a fired alarm that handleTime already claimed', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      // start() 自己的 rebuildInternal() 会把 reader 里这条 time 类型日程注册
      // 上原生闹钟。deliver() 走的是公开 API，不经过 runHandleTime() 的跳过判定，
      // 所以这里仍然用它来验证 deliverLocks/activeDeliveries 这层互斥锁本身没坏。
      await app.start();

      // deliver() 内部 runDeliver() 在第一个 await 之前就同步把 schedule_id 加进
      // deliverLocks/activeDeliveries，所以这里不等它，直接紧接着让 handleTime
      // 也去处理同一条日程，模拟两条通道同时抢同一次触发。
      const started = app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });
      await app.handleTime({ observed_at: '2026-08-18T10:00:00.000Z' });
      const receipt = await started;

      expect(receipt.schedule_id).toBe('s1');
      // 只应该走一条通道：只响一次，不是两次连响。
      expect(deps.vibration.vibrate).toHaveBeenCalledTimes(1);
    });

    it('runHandleTime() skips a time-type schedule whose native alarm is already armed', async () => {
      // 核心的去竞态修复：原生闹钟已经接管的日程，JS 30s 轮询完全不判定、不
      // 投递——哪怕 isTimeWindowReached() 本身会判 true，也不应该走到这一步。
      // 这堵住了"JS tick 抢先送达、顺手把更可靠的原生闹钟撤销掉"这条路。
      const schedule = fixtureSchedule({
        id: 's1',
        reminder: {
          reminder_type: 'at_time',
          reminder_trigger_at: '2026-08-18T10:00:00.000Z',
          reminder_offset_minutes: null,
          reminder_strength: 'high',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      await app.handleTime({ observed_at: '2026-08-18T10:30:00.000Z' });

      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
      expect(deps.presenter.show).not.toHaveBeenCalled();
      expect(deps.systemNotification.show).not.toHaveBeenCalled();
      // 没被投递过，运行时状态压根没落盘。
      await expect(deps.state.read('s1')).resolves.toBeNull();
    });

    it('runHandleTime() still delivers a time-type schedule whose native alarm never armed', async () => {
      // 反过来验证：原生闹钟没挂上（比如权限缺失）的日程，JS 轮询依然是唯一
      // 兜底，不能被上面那条跳过判定误伤。
      const schedule = fixtureSchedule({
        id: 's1',
        reminder: {
          reminder_type: 'at_time',
          reminder_trigger_at: '2026-08-18T10:00:00.000Z',
          reminder_offset_minutes: null,
          reminder_strength: 'high',
        },
      });
      const { alarms } = createFakeAlarms({
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      await app.handleTime({ observed_at: '2026-08-18T10:30:00.000Z' });

      expect(deps.vibration.vibrate).toHaveBeenCalledTimes(1);
    });

    it('skips a schedule already marked pending/confirmed when a duplicate native fire arrives', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: { ...emptyRuntime(), reminder_disposition_state: 'confirmed' },
      });
      const disposition: AlarmNativeDisposition = {
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        state: 'pending',
        updated_at: '2026-08-18T09:30:00.000Z',
      };
      const { alarms } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [disposition]),
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);

      await app.start();

      // 已经是 confirmed 的日程再收到一次 fired：不应该被改写成 pending。
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
      });
    });
  });

  describe('reorder after confirm/postpone', () => {
    it('confirm() cancels the native alarm and stops the schedule from being re-armed', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const { alarms, cancelCalls } = createFakeAlarms();
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const registration = await app.register(schedule);
      expect(registration.alarm_id).not.toBeNull();

      await app.confirm('s1', '2026-08-18T10:05:00.000Z');

      expect(cancelCalls).toContain(registration.alarm_id);
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
        next_trigger_at: null,
      });
    });

    it('reports foreground sync failure after persisting confirmation and releasing delivery', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        schedules: new FakeScheduleReader([schedule]),
        dispositionSync: {
          submitConfirmed: jest.fn(async () => {
            throw new Error('network unavailable');
          }),
        },
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      await expect(app.confirm('s1', '2026-08-18T10:05:00.000Z')).rejects.toThrow(
        'network unavailable',
      );
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
        sync_status: 'pending',
      });

      await deps.state.write('s1', {
        ...emptyRuntime(),
        next_trigger_at: '2026-08-18T10:10:00.000Z',
      });
      await app.handleTime({ observed_at: '2026-08-18T10:10:00.000Z' });

      expect(deps.vibration.vibrate).toHaveBeenCalledTimes(2);
    });

    it('retries a persisted pending confirmation during startup rebuild', async () => {
      const pendingRuntime: ReminderRuntimeState = {
        ...emptyRuntime(),
        reminder_disposition_state: 'confirmed',
        disposition_updated_at: '2026-08-18T10:05:00.000Z',
        sync_status: 'pending',
      };
      const schedule = fixtureSchedule({ id: 's1', runtime: pendingRuntime });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', pendingRuntime);
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(deps.dispositionSync.submitConfirmed).toHaveBeenCalledWith({
        schedule_id: 's1',
        state: 'confirmed',
        updated_at: '2026-08-18T10:05:00.000Z',
        snoozed_until: null,
        sync_status: 'pending',
      });
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
        sync_status: 'synced',
      });
    });

    it('snooze() cancels the current alarm and reschedules one at the new snoozed_until', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const { alarms, cancelCalls, scheduleCalls } = createFakeAlarms();
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const registration = await app.register(schedule);
      const firstAlarmId = registration.alarm_id;
      scheduleCalls.length = 0;

      const result = await app.snooze({
        schedule_id: 's1',
        snooze_until: '2026-08-18T10:20:00.000Z',
      });

      expect(result.accepted).toBe(true);
      expect(cancelCalls).toContain(firstAlarmId);
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]).toMatchObject({
        schedule_id: 's1',
        trigger_at: '2026-08-18T10:20:00.000Z',
      });
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'snoozed',
        next_trigger_at: '2026-08-18T10:20:00.000Z',
      });
    });
  });

  describe('stop/restart', () => {
    it('clears in-memory delivery/registration state on stop, then starts clean again', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const registration = await app.register(schedule);
      expect(registration.alarm_id).not.toBeNull();

      await app.stop();
      expect(deps.time.stop).toHaveBeenCalledWith('time-1');

      // 重启后引擎应该干净可用：重新注册同一条日程要能再拿到一个新闹钟。
      await app.start();
      const secondRegistration = await app.register(schedule);
      expect(secondRegistration.alarm_id).not.toBeNull();
    });

    it('a delivery still in flight when stop() is called does not resurrect state after teardown', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', emptyRuntime());
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      const delivering = app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });
      await app.stop();
      await delivering;

      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: null,
      });
    });

    it('start() bails out early when stop() races in right after recovery.registerForRestart()', async () => {
      // startInternal() 在每个 await 之后都重新检查 isLive(generation)——覆盖
      // registerForRestart() 之后这第一处检查：模拟调用方在这一步就并发调了 stop()。
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        schedules: new FakeScheduleReader([schedule]),
        recovery: {
          registerForRestart: jest.fn(async () => {
            void app.stop();
            return { registered: true, recovery_id: 'r1' };
          }),
          restoreAfterRestart: jest.fn(async () => ({ registered: true, recovery_id: 'r1' })),
        },
      });
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(deps.time.start).not.toHaveBeenCalled();
    });

    it('rebuildInternal() discards freshly-scheduled alarms/registrations when stop() races in during alarms.rebuild()', async () => {
      // rebuildInternal() 在 alarms.rebuild() 返回之后也要重新检查 isLive(generation)：
      // 模拟 stop() 恰好在这次批量排闹钟期间被调用，验证它会撤销掉刚拿到的原生
      // 闹钟、清空 registrations，而不是把一批"属于已失效世代"的注册留下来。
      const schedule = fixtureSchedule({ id: 's1' });
      const { alarms, cancelCalls } = createFakeAlarms({
        rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) => {
          void app.stop();
          return requests.map((request, index) => ({
            alarm_id: `alarm-${index + 1}`,
            schedule_id: request.schedule_id,
            scheduled: true,
          }));
        }),
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);

      await app.start();

      expect(cancelCalls).toContain('alarm-1');
    });

    it('presenter/time callbacks registered at start route into confirm/snooze and handleTime', async () => {
      // onAction 和 time.start 的回调都是 fire-and-forget（void ...），要真的调用
      // 一次才会跑到 handlePresentationAction/handleTime 内部那几行。
      const schedule = fixtureSchedule({ id: 's1' });
      const presenterActionRef: {
        current: ((event: { schedule_id: string; action: 'confirm' | 'snooze' }) => void) | null;
      } = { current: null };
      const timeTickRef: { current: ((tick: { observed_at: string }) => void) | null } = {
        current: null,
      };
      const deps = createDeps({
        schedules: new FakeScheduleReader([schedule]),
        presenter: {
          hide: jest.fn(async () => {}),
          onAction: jest.fn(
            (listener: (event: { schedule_id: string; action: 'confirm' | 'snooze' }) => void) => {
              presenterActionRef.current = listener;
              return () => {
                presenterActionRef.current = null;
              };
            },
          ),
          show: jest.fn(async () => ({ presentation_id: 'p1', visible: true })),
        },
        time: {
          start: jest.fn(async (listener: (tick: { observed_at: string }) => void) => {
            timeTickRef.current = listener;
            return { listener_id: 'time-1' };
          }),
          stop: jest.fn(async () => {}),
        },
      });
      const app = new LocalReminderApplication(deps);
      await app.start();

      presenterActionRef.current?.({ schedule_id: 's1', action: 'confirm' });
      await flushAsync();
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
      });

      timeTickRef.current?.({ observed_at: '2026-08-18T10:30:00.000Z' });
      await flushAsync();
    });
  });

  describe('recurring reminder advancement', () => {
    it('arms the native alarm at the recurring schedule occurrence provided by the state layer', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_kind: 'recurring',
        recurrence_rule: 'FREQ=DAILY',
        runtime: { ...emptyRuntime(), next_trigger_at: '2026-08-18T10:00:00.000Z' },
      });
      const { alarms, scheduleCalls } = createFakeAlarms();
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();

      const registration = await app.register(schedule);

      expect(registration.alarm_id).not.toBeNull();
      expect(scheduleCalls[0]).toMatchObject({
        schedule_id: 's1',
        trigger_at: '2026-08-18T10:00:00.000Z',
      });
    });

    it('re-arms at the next occurrence once the data layer advances next_trigger_at again', async () => {
      // LocalReminderApplication 本身不算 RRULE：next_trigger_at 置空之后，
      // 真正推到下一次发生时间是状态层（例如 SqliteReminderStateStore）的职责
      // ——这里模拟状态层已经算好了第二次 occurrence，验证引擎会正确接上、
      // 重新挂闹钟，而不是卡在第一次触发之后就不再调度。
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_kind: 'recurring',
        recurrence_rule: 'FREQ=DAILY',
        runtime: { ...emptyRuntime(), next_trigger_at: '2026-08-18T10:00:00.000Z' },
      });
      const { alarms, scheduleCalls } = createFakeAlarms();
      const reader = new FakeScheduleReader([schedule]);
      const deps = createDeps({ alarms, schedules: reader });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);
      expect(scheduleCalls[0]?.trigger_at).toBe('2026-08-18T10:00:00.000Z');

      // 状态层算出了下一次 occurrence（模拟 confirmInternal 把光标置空之后，
      // 数据层在下一次 read() 时补上新的 next_trigger_at）。
      await deps.state.write('s1', {
        ...emptyRuntime(),
        next_trigger_at: '2026-08-19T10:00:00.000Z',
      });
      reader.schedules = [
        {
          ...schedule,
          runtime: { ...emptyRuntime(), next_trigger_at: '2026-08-19T10:00:00.000Z' },
        },
      ];

      const registrations = await app.rebuild();

      expect(registrations[0]?.alarm_id).not.toBeNull();
      const latestCall = scheduleCalls[scheduleCalls.length - 1];
      expect(latestCall).toMatchObject({
        schedule_id: 's1',
        trigger_at: '2026-08-19T10:00:00.000Z',
      });
    });
  });

  describe('location triggering', () => {
    function fixtureLocationSchedule(
      overrides: Partial<LocalReminderSchedule> = {},
    ): LocalReminderSchedule {
      return fixtureSchedule({
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        geofence_radius_meters: 100,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'medium',
        },
        ...overrides,
      });
    }

    it('arms the geofence once the sample leaves the zone, without delivering', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      await app.handleLocation({
        latitude: 40,
        longitude: 121.4737,
        accuracy_meters: 10,
        observed_at: '2026-08-18T10:00:00.000Z',
      });

      await expect(deps.state.read('s1')).resolves.toMatchObject({ geofence_armed: true });
      expect(deps.presenter.show).not.toHaveBeenCalled();
    });

    it('does not deliver when the initial sample is already inside the zone', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      let initialListener: ((event: LocationMonitorEvent) => unknown) | undefined;
      const watch = jest.fn(
        async (
          request: LocationWatchRequest,
          listener: (event: LocationMonitorEvent) => unknown,
        ) => {
          initialListener = listener;
          return { listener_id: `loc-${request.schedule_id}`, schedule_id: request.schedule_id };
        },
      );
      deps.location.watch = watch;
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      await initialListener?.({
        schedule_id: 's1',
        sample: {
          latitude: 31.2304,
          longitude: 121.4737,
          accuracy_meters: 10,
          observed_at: '2026-08-18T10:00:00.000Z',
        },
      });

      expect(deps.presenter.show).not.toHaveBeenCalled();
    });

    it('does not treat an initial sample outside the zone as an immediate arrival', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      let initialListener: ((event: LocationMonitorEvent) => unknown) | undefined;
      deps.location.watch = jest.fn(
        async (
          request: LocationWatchRequest,
          listener: (event: LocationMonitorEvent) => unknown,
        ) => {
          initialListener = listener;
          return { listener_id: `loc-${request.schedule_id}`, schedule_id: request.schedule_id };
        },
      );
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      await initialListener?.({
        schedule_id: 's1',
        sample: {
          latitude: 40,
          longitude: 121.4737,
          accuracy_meters: 10,
          observed_at: '2026-08-18T10:00:00.000Z',
        },
      });

      expect(deps.presenter.show).not.toHaveBeenCalled();
      await expect(deps.state.read('s1')).resolves.toMatchObject({ geofence_armed: true });
    });

    it('does not drop the initial sample emitted during a bulk location rebuild', async () => {
      const schedule = fixtureLocationSchedule({
        id: 's1',
        runtime: { ...emptyRuntime(), geofence_armed: true },
      });
      const reader = new FakeScheduleReader([]);
      const deps = createDeps({ schedules: reader });
      deps.location.rebuild = jest.fn(
        async (
          targets: readonly LocationRebuildTarget[],
          listener: (event: LocationMonitorEvent) => void,
        ) => {
          const target = targets[0];
          if (target == null) return [];
          // ExpoLocationMonitor emits its initial sample before rebuild() returns.
          await Promise.resolve(
            listener({
              schedule_id: target.schedule_id,
              sample: {
                latitude: 31.2304,
                longitude: 121.4737,
                accuracy_meters: 10,
                observed_at: '2026-08-18T10:00:00.000Z',
              },
            }),
          );
          return [
            {
              listener_id: `loc-${target.schedule_id}`,
              schedule_id: target.schedule_id,
            },
          ];
        },
      );
      const app = new LocalReminderApplication(deps);
      await app.start();

      reader.schedules = [schedule];
      await deps.state.write('s1', schedule.runtime);
      await app.rebuild();

      expect(deps.presenter.show).toHaveBeenCalledTimes(1);
    });

    it('delivers once an armed geofence is re-entered, then disarms it', async () => {
      const schedule = fixtureLocationSchedule({
        id: 's1',
        runtime: { ...emptyRuntime(), geofence_armed: true },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      await app.handleLocation({
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy_meters: 10,
        observed_at: '2026-08-18T10:00:00.000Z',
      });

      expect(deps.presenter.show).toHaveBeenCalledTimes(1);
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        geofence_armed: false,
        reminder_disposition_state: 'pending',
      });
    });

    it('does not re-deliver a still-armed geofence while the sample stays outside it', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      const farSample = {
        latitude: 40,
        longitude: 121.4737,
        accuracy_meters: 10,
        observed_at: '2026-08-18T10:00:00.000Z',
      };
      await app.handleLocation(farSample);
      await app.handleLocation(farSample);

      expect(deps.presenter.show).not.toHaveBeenCalled();
    });

    it('routes a watch() callback event through runLocationMonitorEvent to arm the geofence', async () => {
      // watchLocationSchedule() 挂给 location.watch() 的回调是
      // handleLocationMonitorEvent → runLocationMonitorEvent，走的是跟 rebuild()
      // 批量重建不同的单条注册路径——直接调用一次这个回调，覆盖它自己的守卫分支
      // （已注册、能拿到日程、类型是 location）。
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      let watchListener:
        | ((event: {
            schedule_id: string;
            sample: {
              latitude: number;
              longitude: number;
              accuracy_meters: number;
              observed_at: string;
            };
          }) => Promise<void>)
        | undefined;
      deps.location.watch = jest.fn(async (request: LocationWatchRequest, listener) => {
        watchListener = listener as typeof watchListener;
        return { listener_id: `loc-${request.schedule_id}`, schedule_id: request.schedule_id };
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);

      await watchListener?.({
        schedule_id: 's1',
        sample: {
          latitude: 40,
          longitude: 121.4737,
          accuracy_meters: 10,
          observed_at: '2026-08-18T10:00:00.000Z',
        },
      });

      await expect(deps.state.read('s1')).resolves.toMatchObject({ geofence_armed: true });
    });

    it('ignores a watch() callback for a schedule that has already been dropped from registrations', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      let watchListener:
        | ((event: {
            schedule_id: string;
            sample: {
              latitude: number;
              longitude: number;
              accuracy_meters: number;
              observed_at: string;
            };
          }) => Promise<void>)
        | undefined;
      deps.location.watch = jest.fn(async (request: LocationWatchRequest, listener) => {
        watchListener = listener as typeof watchListener;
        return { listener_id: `loc-${request.schedule_id}`, schedule_id: request.schedule_id };
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);
      await app.confirm('s1', '2026-08-18T10:00:00.000Z');

      await expect(
        watchListener?.({
          schedule_id: 's1',
          sample: {
            latitude: 40,
            longitude: 121.4737,
            accuracy_meters: 10,
            observed_at: '2026-08-18T10:00:00.000Z',
          },
        }),
      ).resolves.toBeUndefined();
    });

    it('drops a registration whose location.unwatch() call fails, without throwing', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      deps.location.unwatch = jest.fn(async () => {
        throw new Error('unwatch failed');
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const registration = await app.register(schedule);
      expect(registration.location_listener_id).not.toBeNull();

      await expect(app.confirm('s1', '2026-08-18T10:00:00.000Z')).resolves.toMatchObject({
        accepted: true,
      });
    });

    it('notifies onScheduleConfirmed after a confirm commits, but not on register()', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const listener = jest.fn();
      app.onScheduleConfirmed(listener);

      await app.register(schedule);
      expect(listener).not.toHaveBeenCalled();

      await app.confirm('s1', '2026-08-18T10:00:00.000Z');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying onScheduleConfirmed after unsubscribing', async () => {
      const schedule = fixtureLocationSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      const listener = jest.fn();
      const unsubscribe = app.onScheduleConfirmed(listener);
      unsubscribe();

      await app.confirm('s1', '2026-08-18T10:00:00.000Z');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('runDeliver edge receipts', () => {
    it('returns an inflight receipt without re-delivering when the same schedule is already locked', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const trigger = {
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time' as const,
        triggered_at: '2026-08-18T10:00:00.000Z',
      };
      const first = app.deliver(trigger);
      const second = await app.deliver(trigger);

      expect(second.delivery_id).toBe('inflight-s1');
      expect(second.channels).toEqual([]);
      await first;
    });

    it('returns a missing receipt when the schedule cannot be found by id', async () => {
      const deps = createDeps({ schedules: new FakeScheduleReader([]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 'ghost',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(receipt).toMatchObject({ delivery_id: 'missing-ghost', channels: [] });
    });

    it('rolls back runtime and tears down delivery when a channel dependency throws', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      deps.vibration.vibrate = jest.fn(async () => {
        throw new Error('vibrate failed');
      });
      const app = new LocalReminderApplication(deps);
      await app.start();

      await expect(
        app.deliver({
          reminder_id: 'r1',
          schedule_id: 's1',
          reason: 'at_time',
          triggered_at: '2026-08-18T10:00:00.000Z',
        }),
      ).rejects.toThrow('vibrate failed');

      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: null,
      });
    });
  });

  describe('delivery channels by strength', () => {
    it('low strength: system notification only, no popup/vibration/audio', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        reminder: {
          reminder_type: 'at_time',
          reminder_trigger_at: '2026-08-18T10:00:00.000Z',
          reminder_offset_minutes: null,
          reminder_strength: 'low',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(receipt.channels).toEqual(['system_notification']);
      expect(deps.delivery.deliver).toHaveBeenCalledTimes(1);
      expect(deps.systemNotification.show).toHaveBeenCalledTimes(1);
      expect(deps.presenter.show).not.toHaveBeenCalled();
      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
      expect(deps.audio.playTts).not.toHaveBeenCalled();
    });

    it('high strength: popup + vibration + tts, falls back to local audio when tts fails', async () => {
      // 默认的 fake alarms 不实现 presentNow，所以不管日程类型，runDeliver()
      // 都会跳过"原生全屏页优先"这一步、直接走下面这套 JS 强度通道——用 location
      // 类型只是顺手避开 time 类型经 start() 自动挂原生闹钟这件事本身没有影响。
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'high',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      // 默认 fake 的 playLocalFallback 也返回 played:false（"什么都没真的响"这个
      // 中性默认对其它测试没影响）；这里要验证兜底音真的放出来了，单独覆盖一下。
      deps.audio.playLocalFallback = jest.fn(async () => ({
        playback_id: 'p1',
        played: true,
        used_local_fallback: true,
      }));
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(receipt.used_fallback_audio).toBe(true);
      expect(receipt.channels).toEqual(['popup', 'vibration', 'local_sound']);
      expect(deps.audio.playTts).toHaveBeenCalledTimes(1);
      expect(deps.audio.playLocalFallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('native full-screen presentNow takes priority over JS channels', () => {
    it('time-type: uses presentNow when the native alarm never got scheduled', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        reminder: {
          reminder_type: 'at_time',
          reminder_trigger_at: '2026-08-18T10:00:00.000Z',
          reminder_offset_minutes: null,
          reminder_strength: 'high',
        },
      });
      const presentNow = jest.fn(async () => ({
        alarm_id: 'native-1',
        schedule_id: 's1',
        presented: true,
      }));
      const { alarms } = createFakeAlarms({
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
        presentNow,
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(receipt.channels).toEqual(['native_full_screen']);
      expect(presentNow).toHaveBeenCalledWith(
        expect.objectContaining({
          vibrate: true,
          sound_tier: 'full',
          full_screen: true,
          speech_text: '喝水提醒，时间到了。现在已经18点了。',
        }),
      );
      expect(deps.presenter.show).not.toHaveBeenCalled();
      expect(deps.systemNotification.show).not.toHaveBeenCalled();
      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
    });

    it('location-type: uses presentNow with the low-strength ping tier', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        geofence_radius_meters: 100,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'low',
        },
      });
      const presentNow = jest.fn(async () => ({
        alarm_id: 'native-1',
        schedule_id: 's1',
        presented: true,
      }));
      const { alarms } = createFakeAlarms({ presentNow });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'arrive_location',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(receipt.channels).toEqual(['native_full_screen']);
      expect(presentNow).toHaveBeenCalledWith(
        expect.objectContaining({ vibrate: false, sound_tier: 'ping', full_screen: true }),
      );
    });

    it('falls back to JS channels when presentNow is available but declines', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        geofence_radius_meters: 100,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'medium',
        },
      });
      const presentNow = jest.fn(async () => ({
        alarm_id: '',
        schedule_id: 's1',
        presented: false,
      }));
      const { alarms } = createFakeAlarms({ presentNow });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();

      const receipt = await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'arrive_location',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(presentNow).toHaveBeenCalledTimes(1);
      expect(receipt.channels).toEqual(['popup', 'vibration']);
    });
  });

  describe('native alarm ring channels by strength', () => {
    // 全屏三档都要弹（静音也要让用户看得见），vibrate/sound_tier 才按强度递进：
    // 低=一声提示音不震动、中=一声提示音+震动、高=循环语音+震动。
    const cases: [
      ReminderStrength,
      {
        vibrate: boolean;
        sound_tier: 'none' | 'ping' | 'full';
        full_screen: boolean;
        speech_text: string;
      },
    ][] = [
      ['low', { vibrate: false, sound_tier: 'ping', full_screen: true, speech_text: '' }],
      ['medium', { vibrate: true, sound_tier: 'ping', full_screen: true, speech_text: '' }],
      [
        'high',
        {
          vibrate: true,
          sound_tier: 'full',
          full_screen: true,
          speech_text: '喝水提醒，时间到了。现在已经18点了。',
        },
      ],
    ];
    it.each(cases)('%s strength schedules the native alarm with %j', async (strength, expected) => {
      const schedule = fixtureSchedule({
        id: 's1',
        reminder: {
          reminder_type: 'at_time',
          reminder_trigger_at: '2026-08-18T10:00:00.000Z',
          reminder_offset_minutes: null,
          reminder_strength: strength,
        },
      });
      const { alarms, scheduleCalls } = createFakeAlarms();
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      // start() 的 rebuild 已经把这条日程排过一次；重置掉，只看接下来这次
      // register() 调用实际传给原生的 vibrate/sound_tier/full_screen。
      scheduleCalls.length = 0;

      const registration = await app.register(schedule);

      expect(registration.alarm_id).not.toBeNull();
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]).toMatchObject(expected);
    });
  });

  describe('native alarm events (dismissed/snoozed) routed through subscribe', () => {
    it('routes a native "snoozed" event to snooze() and "dismissed" to confirm()', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const listenerRef: { current: ((event: AlarmNativeEvent) => void) | null } = {
        current: null,
      };
      const { alarms } = createFakeAlarms({
        subscribe: jest.fn((listener: (event: AlarmNativeEvent) => void) => {
          listenerRef.current = listener;
          return () => {
            listenerRef.current = null;
          };
        }),
      });
      const deps = createDeps({ alarms, schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      await app.start();
      expect(listenerRef.current).not.toBeNull();

      listenerRef.current?.({
        type: 'snoozed',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: schedule.title,
        at: '2026-08-18T10:00:00.000Z',
      });
      await flushAsync();
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'snoozed',
      });

      listenerRef.current?.({
        type: 'dismissed',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: schedule.title,
        at: '2026-08-18T10:05:00.000Z',
      });
      await flushAsync();
      await expect(deps.state.read('s1')).resolves.toMatchObject({
        reminder_disposition_state: 'confirmed',
      });

      await app.stop();
      expect(listenerRef.current).toBeNull();
    });
  });

  describe('permission gap reporting', () => {
    function statusWith(
      overrides: Partial<
        Record<'exact_alarm' | 'overlay' | 'location_foreground' | 'location_background', boolean>
      >,
    ) {
      return {
        platform: 'android' as const,
        supported: true,
        permissions: {
          notifications: true,
          exact_alarm: true,
          overlay: true,
          full_screen: true,
          battery_optimization: true,
          location_foreground: true,
          location_background: true,
          microphone: true,
          ...overrides,
        },
        background_execution: true,
        oemGuidance: {
          manufacturer: null,
          autostartGuided: false,
          backgroundPopupGuided: false,
          lastOverlayFailed: false,
        },
      };
    }

    it('notifies onPermissionBlocked with the permissions a newly-registered time schedule is missing', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => statusWith({ exact_alarm: false, overlay: false })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
      });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      app.onPermissionBlocked(listener);
      await app.start();

      await app.register(schedule);
      await flushAsync();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        schedule_id: 's1',
        missing: ['exact_alarm', 'overlay'],
      });
    });

    it('does not notify when a time schedule has every permission it needs', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      app.onPermissionBlocked(listener);
      await app.start();

      await app.register(schedule);
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies with missing location permissions after registering a location schedule', async () => {
      // guard 现在完全靠带 foregroundService 的前台服务驱动地点判定（原生围栏已删），
      // 而 startLocationUpdatesAsync 带 foregroundService 时原生侧根本不检查后台
      // 定位权限——只要求前台/使用时权限。所以这里只应该报 location_foreground，
      // 不该再把 location_background 当成必需项去提示用户开启"始终允许"。
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'medium',
        },
      });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => statusWith({ location_foreground: false })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
      });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      app.onPermissionBlocked(listener);
      await app.start();

      await app.register(schedule);
      await flushAsync();

      expect(listener).toHaveBeenCalledWith({
        schedule_id: 's1',
        missing: ['location_foreground'],
      });
    });

    it('does not notify about background location once foreground permission is granted', async () => {
      // 回归防护：就算用户始终没给"始终允许"，只要前台权限在，地点提醒也不该
      // 再被标成缺权限——location_background 已经不是这条路径的必需项。
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'medium',
        },
      });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => statusWith({ location_background: false })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
      });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      app.onPermissionBlocked(listener);
      await app.start();

      await app.register(schedule);
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not re-notify for the same schedule during a bulk rebuild', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => statusWith({ exact_alarm: false })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
      });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      app.onPermissionBlocked(listener);
      await app.start();

      await app.register(schedule);
      await flushAsync();
      expect(listener).toHaveBeenCalledTimes(1);

      await app.rebuild();
      await flushAsync();

      // rebuild() re-arms via the batch alarms/location.rebuild() ports, not
      // scheduleAlarmFor/watchLocationSchedule, so it must not fire again --
      // otherwise every rebuild (e.g. one triggered by granting some other
      // permission) would re-prompt for schedules already reported once.
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying once unsubscribed', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => statusWith({ exact_alarm: false })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
      });
      const app = new LocalReminderApplication(deps);
      const listener = jest.fn();
      const unsubscribe = app.onPermissionBlocked(listener);
      unsubscribe();
      await app.start();

      await app.register(schedule);
      await flushAsync();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('stuck-pending rescue (session-alive)', () => {
    it('re-delivers a schedule stuck in pending for longer than the threshold', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: {
          ...emptyRuntime(),
          reminder_disposition_state: 'pending',
          disposition_updated_at: '2026-08-18T10:00:00.000Z',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();

      // 卡了超过 2 分钟（阈值）还没确认/延后。
      await app.handleTime({ observed_at: '2026-08-18T10:02:30.000Z' });

      expect(deps.vibration.vibrate).toHaveBeenCalledTimes(1);
    });

    it('does not re-deliver a schedule still within the stuck threshold', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: {
          ...emptyRuntime(),
          reminder_disposition_state: 'pending',
          disposition_updated_at: '2026-08-18T10:00:00.000Z',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();

      // 才卡了 1 分钟，还没到 2 分钟阈值。
      await app.handleTime({ observed_at: '2026-08-18T10:01:00.000Z' });

      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
    });

    it('does not re-deliver a confirmed schedule', async () => {
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: {
          ...emptyRuntime(),
          reminder_disposition_state: 'confirmed',
          disposition_updated_at: '2026-08-18T10:00:00.000Z',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();

      await app.handleTime({ observed_at: '2026-08-18T10:30:00.000Z' });

      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
    });

    it('backs off when a concurrent confirm changes disposition_updated_at between the two reads', async () => {
      // confirm()/snooze() 走独立的 opChain，跟 30s tick 之间没有共享锁——模拟这个
      // 竞态窗口：第一次读到"卡住的旧时间戳"，触发前再读一次时已经被 confirm 抢先
      // 改掉了，必须放弃这次补弹，不能把刚确认完的提醒又弹回来。
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: {
          ...emptyRuntime(),
          reminder_disposition_state: 'pending',
          disposition_updated_at: '2026-08-18T10:00:00.000Z',
        },
      });
      const deps = createDeps({ schedules: new FakeScheduleReader([schedule]) });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();

      const originalRead = deps.state.read.bind(deps.state);
      let readCount = 0;
      deps.state.read = jest.fn(async (scheduleId: string) => {
        readCount += 1;
        // 第一次读（判定是否卡住）之后，模拟一次并发 confirm() 把状态改掉，
        // 再验证第二次读（recheck）能看到这个变化并放弃。
        if (readCount === 1) {
          const result = await originalRead(scheduleId);
          await deps.state.write(scheduleId, {
            ...(result ?? emptyRuntime()),
            reminder_disposition_state: 'confirmed',
            disposition_updated_at: '2026-08-18T10:02:00.000Z',
          });
          return result;
        }
        return originalRead(scheduleId);
      });

      await app.handleTime({ observed_at: '2026-08-18T10:02:30.000Z' });

      expect(deps.vibration.vibrate).not.toHaveBeenCalled();
    });
  });

  describe('client telemetry', () => {
    it('records native_ok when the native alarm fires', async () => {
      const schedule = fixtureSchedule({ id: 's1' });
      const telemetry = new RecordingTelemetry();
      const listenerRef: { current: ((event: AlarmNativeEvent) => void) | null } = {
        current: null,
      };
      const { alarms } = createFakeAlarms({
        subscribe: jest.fn((listener: (event: AlarmNativeEvent) => void) => {
          listenerRef.current = listener;
          return () => {
            listenerRef.current = null;
          };
        }),
      });
      const deps = createDeps({
        alarms,
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();

      listenerRef.current?.({
        type: 'fired',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: schedule.title,
        at: '2026-08-18T10:00:00.000Z',
      });
      await flushAsync();

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          channel: 'native_full_screen',
          manufacturer: 'other',
          outcome: 'native_ok',
          overlay_failed: false,
          schedule_type: 'time',
          strength: 'medium',
          used_fallback_audio: false,
        }),
      ]);
    });

    it('does not record native_ok when hydrating a pending native disposition', async () => {
      const telemetry = new RecordingTelemetry();
      const { alarms } = createFakeAlarms({
        peekNativeDispositions: jest.fn(async () => [
          {
            schedule_id: 's1',
            alarm_id: 'alarm-1',
            state: 'pending' as const,
            updated_at: '2026-08-18T09:30:00.000Z',
          },
        ]),
      });
      const deps = createDeps({ alarms, telemetry });
      const app = new LocalReminderApplication(deps);
      await app.start();
      expect(telemetry.deliveries).toEqual([]);
    });

    it('records js_channel for a location reminder that used the JS popup path', async () => {
      const telemetry = new RecordingTelemetry();
      const schedule = fixtureSchedule({
        id: 's1',
        schedule_type: 'location',
        latitude: 31.2304,
        longitude: 121.4737,
        reminder: {
          reminder_type: 'arrive_location',
          reminder_trigger_at: null,
          reminder_offset_minutes: null,
          reminder_strength: 'high',
        },
      });
      const deps = createDeps({
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();

      await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'arrive_location',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          channel: 'popup',
          outcome: 'js_channel',
          schedule_type: 'location',
          strength: 'high',
          used_fallback_audio: true,
        }),
      ]);
      expect(JSON.stringify(telemetry.deliveries)).not.toContain('喝水');
    });

    it('does not record js_channel when a native alarm already owns the ring UI', async () => {
      const telemetry = new RecordingTelemetry();
      const schedule = fixtureSchedule({ id: 's1' });
      const listenerRef: { current: ((event: AlarmNativeEvent) => void) | null } = {
        current: null,
      };
      const { alarms } = createFakeAlarms({
        subscribe: jest.fn((listener: (event: AlarmNativeEvent) => void) => {
          listenerRef.current = listener;
          return () => {
            listenerRef.current = null;
          };
        }),
      });
      const deps = createDeps({
        alarms,
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();

      listenerRef.current?.({
        type: 'fired',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: schedule.title,
        at: '2026-08-18T10:00:00.000Z',
      });
      await flushAsync();

      await app.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        reason: 'at_time',
        triggered_at: '2026-08-18T10:00:00.000Z',
      });

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          channel: 'native_full_screen',
          outcome: 'native_ok',
        }),
      ]);
    });

    it('records native_declined when a time schedule cannot be hung on the native alarm', async () => {
      const telemetry = new RecordingTelemetry();
      const schedule = fixtureSchedule({ id: 's1' });
      const { alarms } = createFakeAlarms({
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({
        alarms,
        device: {
          getStatus: jest.fn(async () => ({
            platform: 'android' as const,
            supported: true,
            permissions: {
              notifications: true,
              exact_alarm: false,
              overlay: true,
              full_screen: true,
              battery_optimization: true,
              location_foreground: true,
              location_background: true,
              microphone: true,
            },
            background_execution: true,
            oemGuidance: {
              manufacturer: 'xiaomi' as const,
              autostartGuided: false,
              backgroundPopupGuided: false,
              lastOverlayFailed: false,
            },
          })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.deliveries.length = 0;
      telemetry.permissions.length = 0;

      await app.register(schedule);
      await flushAsync();

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          channel: 'native_full_screen',
          manufacturer: 'xiaomi',
          outcome: 'native_declined',
          schedule_type: 'time',
        }),
      ]);
      expect(telemetry.permissions).toEqual([
        expect.objectContaining({
          manufacturer: 'xiaomi',
          missing: ['exact_alarm'],
        }),
      ]);
    });

    it('does not re-record permission gaps during rebuild', async () => {
      const telemetry = new RecordingTelemetry();
      const schedule = fixtureSchedule({ id: 's1' });
      const deps = createDeps({
        device: {
          getStatus: jest.fn(async () => ({
            platform: 'android' as const,
            supported: true,
            permissions: {
              notifications: true,
              exact_alarm: false,
              overlay: true,
              full_screen: true,
              battery_optimization: true,
              location_foreground: true,
              location_background: true,
              microphone: true,
            },
            background_execution: true,
            oemGuidance: {
              manufacturer: null,
              autostartGuided: false,
              backgroundPopupGuided: false,
              lastOverlayFailed: false,
            },
          })),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await app.register(schedule);
      await flushAsync();
      const permissionCount = telemetry.permissions.length;

      await app.rebuild();
      await flushAsync();

      expect(telemetry.permissions).toHaveLength(permissionCount);
    });

    it('marks a late JS time catch-up after opening the app as deferred_until_foreground', async () => {
      const telemetry = new RecordingTelemetry();
      const lifecycle = createLifecycle('active');
      const { alarms } = createFakeAlarms({
        rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) =>
          requests.map((request) => ({
            alarm_id: '',
            schedule_id: request.schedule_id,
            scheduled: false,
          })),
        ),
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({
        alarms,
        lifecycle,
        schedules: new FakeScheduleReader([fixtureSchedule({ id: 's1' })]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.deliveries.length = 0;

      await app.handleTime({ observed_at: '2026-08-18T10:30:00.000Z' });

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          app_state: 'active',
          deferred_until_foreground: true,
          latency_bucket: 'late_30m',
          native_armed: false,
          outcome: 'js_channel',
          trigger_source: 'js_time',
        }),
      ]);
    });

    it('does not mark a live native alarm as deferred even if JS learns about it late', async () => {
      const telemetry = new RecordingTelemetry();
      const lifecycle = createLifecycle('background');
      const listenerRef: { current: ((event: AlarmNativeEvent) => void) | null } = {
        current: null,
      };
      const { alarms } = createFakeAlarms({
        subscribe: jest.fn((listener: (event: AlarmNativeEvent) => void) => {
          listenerRef.current = listener;
          return () => {
            listenerRef.current = null;
          };
        }),
      });
      const deps = createDeps({
        alarms,
        lifecycle,
        schedules: new FakeScheduleReader([fixtureSchedule({ id: 's1' })]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.deliveries.length = 0;

      listenerRef.current?.({
        type: 'fired',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: '喝水提醒',
        at: '2026-08-18T10:30:00.000Z',
      });
      await flushAsync();

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          app_state: 'background',
          deferred_until_foreground: false,
          latency_bucket: 'late_30m',
          outcome: 'native_ok',
          trigger_source: 'native_alarm',
        }),
      ]);
    });

    it('reports persisted native background fire failures once on start', async () => {
      const telemetry = new RecordingTelemetry();
      const ackNativeFireAttempts = jest.fn(async () => {});
      const { alarms } = createFakeAlarms({
        peekNativeFireAttempts: jest.fn(async () => [
          { result: 'service_denied' as const, at: '2026-08-18T09:50:00.000Z' },
          { result: 'service_denied' as const, at: '2026-08-18T09:51:00.000Z' },
          { result: 'present_failed' as const, at: '2026-08-18T09:52:00.000Z' },
        ]),
        ackNativeFireAttempts,
      });
      const deps = createDeps({ alarms, telemetry });
      const app = new LocalReminderApplication(deps);
      await app.start();

      expect(telemetry.nativeBackground).toEqual([
        expect.objectContaining({ result: 'service_denied' }),
        expect.objectContaining({ result: 'present_failed' }),
      ]);
      expect(ackNativeFireAttempts).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(telemetry.nativeBackground)).not.toContain('s1');
    });

    it('ignores unknown native background results and still acks the buffer', async () => {
      const telemetry = new RecordingTelemetry();
      const ackNativeFireAttempts = jest.fn(async () => {});
      const { alarms } = createFakeAlarms({
        peekNativeFireAttempts: jest.fn(async () => [
          { result: 'not-a-result' as 'service_denied', at: '2026-08-18T09:50:00.000Z' },
        ]),
        ackNativeFireAttempts,
      });
      const deps = createDeps({ alarms, telemetry });
      const app = new LocalReminderApplication(deps);
      await app.start();

      expect(telemetry.nativeBackground).toEqual([]);
      expect(ackNativeFireAttempts).toHaveBeenCalledTimes(1);
    });

    it('reports overdue unarmed time schedules when returning to the foreground', async () => {
      const telemetry = new RecordingTelemetry();
      const lifecycle = createLifecycle('active');
      const { alarms } = createFakeAlarms({
        rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) =>
          requests.map((request) => ({
            alarm_id: '',
            schedule_id: request.schedule_id,
            scheduled: false,
          })),
        ),
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({
        alarms,
        lifecycle,
        schedules: new FakeScheduleReader([fixtureSchedule({ id: 's1' })]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      await flushAsync();

      expect(telemetry.lifecycle).toEqual([
        expect.objectContaining({
          kind: 'foreground_resume',
          overdue_unarmed: 'one',
        }),
      ]);

      telemetry.lifecycle.length = 0;
      lifecycle.emit('background');
      lifecycle.emit('active');
      await flushAsync();

      expect(telemetry.lifecycle).toEqual([
        expect.objectContaining({
          kind: 'foreground_resume',
          overdue_unarmed: 'one',
        }),
      ]);
    });

    it('records unexpected delivery errors from the time tick without a schedule id', async () => {
      const telemetry = new RecordingTelemetry();
      const { alarms } = createFakeAlarms({
        rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) =>
          requests.map((request) => ({
            alarm_id: '',
            schedule_id: request.schedule_id,
            scheduled: false,
          })),
        ),
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({
        alarms,
        schedules: new FakeScheduleReader([fixtureSchedule({ id: 's1' })]),
        telemetry,
      });
      deps.vibration.vibrate = jest.fn(async () => {
        throw new Error('vibrate failed');
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.errors.length = 0;

      await app.handleTime({ observed_at: '2026-08-18T10:00:00.000Z' });
      await flushAsync();

      expect(telemetry.errors).toEqual(['reminder_delivery']);
      expect(JSON.stringify(telemetry.errors)).not.toContain('s1');
    });

    it('records stuck_pending catch-up through the JS channel', async () => {
      const telemetry = new RecordingTelemetry();
      const schedule = fixtureSchedule({
        id: 's1',
        runtime: {
          ...emptyRuntime(),
          reminder_disposition_state: 'pending',
          disposition_updated_at: '2026-08-18T10:00:00.000Z',
        },
      });
      const { alarms } = createFakeAlarms({
        rebuild: jest.fn(async (requests: readonly AlarmScheduleRequest[]) =>
          requests.map((request) => ({
            alarm_id: '',
            schedule_id: request.schedule_id,
            scheduled: false,
          })),
        ),
        schedule: jest.fn(async (request: AlarmScheduleRequest) => ({
          alarm_id: '',
          schedule_id: request.schedule_id,
          scheduled: false,
        })),
      });
      const deps = createDeps({
        alarms,
        schedules: new FakeScheduleReader([schedule]),
        telemetry,
      });
      await deps.state.write('s1', schedule.runtime);
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.deliveries.length = 0;

      await app.handleTime({ observed_at: '2026-08-18T10:02:30.000Z' });
      await flushAsync();

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          outcome: 'js_channel',
          trigger_source: 'stuck_pending',
        }),
      ]);
    });

    it('falls back to other manufacturer tags when device status cannot be read', async () => {
      const telemetry = new RecordingTelemetry();
      const listenerRef: { current: ((event: AlarmNativeEvent) => void) | null } = {
        current: null,
      };
      const { alarms } = createFakeAlarms({
        subscribe: jest.fn((listener: (event: AlarmNativeEvent) => void) => {
          listenerRef.current = listener;
          return () => {
            listenerRef.current = null;
          };
        }),
      });
      const deps = createDeps({
        alarms,
        device: {
          getStatus: jest.fn(async () => {
            throw new Error('device down');
          }),
          onAppActive: jest.fn(() => () => {}),
          openOemSettings: jest.fn(async () => true),
          openSettings: jest.fn(async () => true),
          requestPermission: jest.fn(async () => true),
        },
        schedules: new FakeScheduleReader([fixtureSchedule({ id: 's1' })]),
        telemetry,
      });
      const app = new LocalReminderApplication(deps);
      await app.start();
      telemetry.deliveries.length = 0;

      listenerRef.current?.({
        type: 'fired',
        schedule_id: 's1',
        alarm_id: 'alarm-1',
        title: '喝水提醒',
        at: '2026-08-18T10:00:00.000Z',
      });
      await flushAsync();

      expect(telemetry.deliveries).toEqual([
        expect.objectContaining({
          manufacturer: 'other',
          outcome: 'native_ok',
          overlay_failed: false,
        }),
      ]);
    });
  });
});

class RecordingTelemetry implements ClientTelemetryPort {
  readonly deliveries: ReminderDeliveryTelemetry[] = [];
  readonly permissions: ReminderPermissionBlockedTelemetry[] = [];
  readonly lifecycle: ReminderLifecycleTelemetry[] = [];
  readonly nativeBackground: ReminderNativeBackgroundTelemetry[] = [];
  readonly errors: string[] = [];
  readonly contexts: DeviceTelemetryContext[] = [];

  setDeviceContext(context: DeviceTelemetryContext): void {
    this.contexts.push(context);
  }

  recordReminderDelivery(event: ReminderDeliveryTelemetry): void {
    this.deliveries.push(event);
  }

  recordReminderPermissionBlocked(event: ReminderPermissionBlockedTelemetry): void {
    this.permissions.push(event);
  }

  recordReminderLifecycle(event: ReminderLifecycleTelemetry): void {
    this.lifecycle.push(event);
  }

  recordReminderNativeBackground(event: ReminderNativeBackgroundTelemetry): void {
    this.nativeBackground.push(event);
  }

  recordUnexpectedError(kind: 'reminder_delivery'): void {
    this.errors.push(kind);
  }
}

function createLifecycle(initial: TelemetryAppState = 'unknown') {
  let current = initial;
  const listeners = new Set<(state: TelemetryAppState) => void>();
  return {
    current: () => current,
    subscribe: (listener: (state: TelemetryAppState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(next: TelemetryAppState) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}
