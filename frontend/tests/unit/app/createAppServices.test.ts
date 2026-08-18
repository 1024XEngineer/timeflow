import { describe, expect, it, jest } from '@jest/globals';

import { createAppServices } from '../../../src/app/composition/createAppServices';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { MockAlarmScheduler } from '../../../src/infrastructure/notifications/MockAlarmScheduler';
import { MockDeviceCapability } from '../../../src/infrastructure/notifications/MockDeviceCapability';

describe('createAppServices', () => {
  it('exposes authenticated transports and registers production account cleaners', async () => {
    const services = createAppServices({
      auth: {
        fetch: createSuccessfulAuthFetch() as typeof global.fetch,
        store: new FakeAuthSessionStore(),
      },
    });
    const stopReminder = jest.spyOn(services.reminder, 'stop');
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
  });

  it('wires mock auth and device ports when preview mock mode is on', async () => {
    const previous = process.env.EXPO_PUBLIC_MOCK_MODE;
    process.env.EXPO_PUBLIC_MOCK_MODE = '1';
    try {
      const fetch = jest.fn();
      const services = createAppServices({
        auth: {
          fetch: fetch as typeof global.fetch,
          now: () => 100_000,
          store: new FakeAuthSessionStore(),
        },
      });

      await services.auth.controller.authenticate({
        password: 'password123',
        username: 'reviewer',
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(services.auth.controller.getViewState()).toEqual({
        accountId: 'mock-account-001',
        status: 'authenticated',
        username: 'reviewer',
      });
      expect(services.reminderPorts.alarms).toBeInstanceOf(MockAlarmScheduler);
      expect(services.reminderPorts.device).toBeInstanceOf(MockDeviceCapability);
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_MOCK_MODE;
      } else {
        process.env.EXPO_PUBLIC_MOCK_MODE = previous;
      }
    }
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
