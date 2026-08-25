import { describe, expect, it, jest } from '@jest/globals';

import { createAppServices } from '../../../src/app/composition/createAppServices';
import {
  ReminderDispositionHttpSync,
  SqliteLocalScheduleReader,
  SqliteReminderStateStore,
} from '../../../src/features/reminder';
import { subscribeGuardTaskEvents } from '../../../src/infrastructure/location/reminderGuardTask';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';

jest.mock('@sentry/react-native');
jest.mock('../../../src/infrastructure/location/reminderGuardTask', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/infrastructure/location/reminderGuardTask')
  >('../../../src/infrastructure/location/reminderGuardTask');
  return {
    GUARD_TASK_NAME: actual.GUARD_TASK_NAME,
    subscribeGuardTaskEvents: jest.fn(() => () => {}),
    resolveNextPollIntervalMs: actual.resolveNextPollIntervalMs,
  };
});

describe('createAppServices', () => {
  it('exposes authenticated transports and registers production account cleaners', async () => {
    const services = createAppServices({
      auth: {
        fetch: createSuccessfulAuthFetch() as typeof global.fetch,
        store: new FakeAuthSessionStore(),
      },
    });
    const stopReminder = jest.spyOn(services.reminder, 'stop');
    const startTimeListener = jest.spyOn(services.reminderPorts.time, 'start');
    services.scheduleView.replace(
      { accountId: 'acc_001', selectedDate: '2026-08-12', timezone: 'Asia/Shanghai' },
      [],
    );
    await services.runtime.start();

    await services.auth.invalidationCoordinator.invalidate('revoked');

    expect(services.protectedClient).toBe(services.auth.protectedClient);
    expect(services.webSocketClient).toBe(services.auth.webSocketClient);
    expect(services.reminderPorts.schedules).toBe(services.schedules);
    expect(services.reminderPorts.state).toBe(services.reminderState);
    expect(services.reminderPorts.dispositionSync).toBeInstanceOf(ReminderDispositionHttpSync);
    expect(services.schedules).toBeInstanceOf(SqliteLocalScheduleReader);
    expect(services.reminderState).toBeInstanceOf(SqliteReminderStateStore);
    expect(services.scheduleView.getSnapshot()).toEqual({
      accountId: null,
      occurrences: [],
      selectedDate: null,
      timezone: null,
    });
    expect(stopReminder).toHaveBeenCalledTimes(1);
    // reminder 是真的 LocalReminderApplication，不是 Mock：start() 应该真的调用
    // 到 reminderPorts.time.start()，证明组合根接的是会消费这些端口的引擎，
    // 不是一个 start()/handleTime() 全是空操作的桩。
    expect(startTimeListener).toHaveBeenCalledTimes(1);
  });

  it('routes guard samples through the coordinator into reminder.handleLocation', async () => {
    type Sample = {
      latitude: number;
      longitude: number;
      accuracy_meters: number;
      observed_at: string;
    };
    let sampleListener: ((sample: Sample) => void) | undefined;
    const subscribe = subscribeGuardTaskEvents as jest.MockedFunction<
      typeof subscribeGuardTaskEvents
    >;
    subscribe.mockImplementation((listener) => {
      sampleListener = listener as typeof sampleListener;
      return () => {};
    });

    const services = createAppServices({
      auth: {
        fetch: createSuccessfulAuthFetch() as typeof global.fetch,
        store: new FakeAuthSessionStore(),
      },
    });
    const handleLocation = jest
      .spyOn(services.reminder, 'handleLocation')
      .mockResolvedValue(undefined);
    await services.runtime.start();

    const sample: Sample = {
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: '2026-08-18T10:00:00.000Z',
    };
    await sampleListener?.(sample);
    // handleSample 是 fire-and-forget（void handleSample），松开微任务让它跑到
    // handleLocation 那次调用。
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }

    expect(handleLocation).toHaveBeenCalledWith(sample);
    handleLocation.mockRestore();
    await services.runtime.stop();
  });
});

function createSuccessfulAuthFetch() {
  return jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          account_id: 'acc_001',
          access_token: 'opaque-token',
          expires_in: 3600,
        }),
      }) as Response,
  );
}
