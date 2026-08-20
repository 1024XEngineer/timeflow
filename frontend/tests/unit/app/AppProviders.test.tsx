import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import type { AppServices } from '../../../src/app/composition/createAppServices';

jest.mock('../../../src/features/auth/presentation/AuthProvider', () => ({
  AuthProvider: ({ children }: PropsWithChildren) => children,
  useAuth: () => ({
    viewState: { status: 'authenticated', accountId: 'acc-1', username: 'user-1' },
  }),
}));

jest.mock('../../../src/features/reminder', () => ({
  useReminderPermissionsOnLaunch: (
    _device: unknown,
    _dialog: unknown,
    onPermissionsUpdated?: () => void,
  ) => {
    // 直接同步调用，模拟"这一次渲染就报告了权限更新"，覆盖 AppProviders 把
    // 回调接到 reminder.rebuild() 上的那一行。
    onPermissionsUpdated?.();
  },
}));

// AppProviders imports AuthProvider/useReminderPermissionsOnLaunch; jest.mock hoists
// above imports, so this import must come after the mocks are declared.
// eslint-disable-next-line import/first
import { AppProviders } from '../../../src/app/AppProviders';

function createServices(): AppServices {
  return {
    reminder: { rebuild: jest.fn() },
    reminderPorts: { device: {} },
    alertDialog: {},
    runtime: { start: jest.fn(), stop: jest.fn() },
    protectedClient: {},
    scheduleView: {},
    webSocketClient: {},
  } as unknown as AppServices;
}

describe('AppProviders', () => {
  it('rebuilds the reminder engine once permissions are updated', () => {
    const services = createServices();

    render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );

    expect(services.reminder.rebuild).toHaveBeenCalledTimes(1);
  });
});
