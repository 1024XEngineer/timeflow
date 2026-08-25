import { describe, expect, it, jest } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import type { AppServices } from '../../../src/app/composition/createAppServices';

let mockAuthStatus: 'authenticated' | 'unauthenticated' = 'authenticated';

jest.mock('../../../src/features/auth/presentation/AuthProvider', () => ({
  AuthProvider: ({ children }: PropsWithChildren) => children,
  useAuth: () => ({
    viewState:
      mockAuthStatus === 'authenticated'
        ? { status: 'authenticated', accountId: 'acc-1', username: 'user-1' }
        : { status: 'unauthenticated' },
  }),
}));

// AppProviders imports AuthProvider; jest.mock hoists above imports, so this
// import must come after the mock is declared.
// eslint-disable-next-line import/first
import { AppProviders } from '../../../src/app/AppProviders';

function createServices(): AppServices {
  return {
    reminder: { rebuild: jest.fn() },
    reminderPorts: { device: {} },
    alertDialog: {},
    runtime: {
      start: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    protectedClient: {},
    scheduleView: {},
    webSocketClient: {},
  } as unknown as AppServices;
}

describe('AppProviders', () => {
  it('starts the reminder runtime once authenticated', () => {
    mockAuthStatus = 'authenticated';
    const services = createServices();

    render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );

    expect(services.runtime.start).toHaveBeenCalledTimes(1);
    expect(services.runtime.stop).not.toHaveBeenCalled();
  });

  it('does not start the runtime while unauthenticated', () => {
    mockAuthStatus = 'unauthenticated';
    const services = createServices();

    render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );

    expect(services.runtime.start).not.toHaveBeenCalled();
  });

  it('stops the runtime on unmount', () => {
    mockAuthStatus = 'authenticated';
    const services = createServices();

    const { unmount } = render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );
    unmount();

    expect(services.runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('logs instead of throwing an unhandled rejection when runtime.start() fails', async () => {
    mockAuthStatus = 'authenticated';
    const services = createServices();
    const startError = new Error('module start failed');
    (services.runtime.start as jest.Mock<() => Promise<void>>).mockRejectedValue(startError);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[app] runtime.start() failed', startError),
    );
    errorSpy.mockRestore();
  });

  it('logs instead of throwing an unhandled rejection when runtime.stop() fails', async () => {
    mockAuthStatus = 'authenticated';
    const services = createServices();
    const stopError = new Error('module stop failed');
    (services.runtime.stop as jest.Mock<() => Promise<void>>).mockRejectedValue(stopError);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <AppProviders authController={{} as never} services={services}>
        {null}
      </AppProviders>,
    );
    unmount();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[app] runtime.stop() failed', stopError),
    );
    errorSpy.mockRestore();
  });
});
