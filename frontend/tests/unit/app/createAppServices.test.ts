import { describe, expect, it, jest } from '@jest/globals';

import { createAppServices } from '../../../src/app/composition/createAppServices';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';

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
