import { describe, expect, it, jest } from '@jest/globals';

import { LocalReminderApplication } from '../../../../../src/features/reminder/application/LocalReminderApplication';
import type {
  AlarmNativeDisposition,
  AlarmNativeEvent,
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
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
} from '../../../../../src/features/reminder/domain';

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
      // 上原生闹钟，之后 popup/audio 就会因为"原生已经托管响铃 UI"被跳过——
      // 用不受这条影响的 vibration 通道来判断到底响了几次更直接。
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

    it('keeps confirmation local and releases delivery after cloud sync fails', async () => {
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

      await expect(app.confirm('s1', '2026-08-18T10:05:00.000Z')).resolves.toMatchObject({
        accepted: true,
        disposition: {
          state: 'confirmed',
          sync_status: 'pending',
        },
      });
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
      // 用 location 类型：time 类型经过 start() 内部 rebuild 会自动挂上原生闹钟，
      // 一旦 nativeAlarmOwnsRingUi 为真，popup/audio 都会被跳过——这里就是要
      // 验证这两个通道本身，用不会触发这条豁免的日程类型。
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

      expect(listener).toHaveBeenCalledWith({
        schedule_id: 's1',
        missing: ['location_background'],
      });
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
});
