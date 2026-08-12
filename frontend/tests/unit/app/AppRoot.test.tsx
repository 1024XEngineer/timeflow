import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AppRoot } from '../../../src/app/AppRoot';
import { AuthController } from '../../../src/features/auth/application';
import { FakeAuthSessionStore } from '../../../src/features/auth/testing/FakeAuthSessionStore';
import { openTimeflowDatabase } from '../../../src/infrastructure/database';

jest.mock('../../../src/infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
}));
jest.mock('../../../src/features/schedule/data', () => ({ ScheduleLocalRepository: jest.fn() }));
jest.mock('../../../src/features/schedule/application', () => ({
  SqliteScheduleClientService: jest.fn(),
}));
jest.mock('../../../src/features/schedule/presentation/ScheduleCalendarScreen', () => ({
  ScheduleCalendarScreen: () => {
    const { Text } = jest.requireActual('react-native') as typeof import('react-native');
    return <Text>日程日历</Text>;
  },
}));

const mockedOpenTimeflowDatabase = openTimeflowDatabase as jest.MockedFunction<
  typeof openTimeflowDatabase
>;

beforeEach(() => {
  mockedOpenTimeflowDatabase.mockReset();
  mockedOpenTimeflowDatabase.mockResolvedValue({} as never);
});

describe('AppRoot', () => {
  it.each([
    ['renders a pending restoration', undefined, undefined, true, '正在恢复登录状态'],
    [
      'renders a restoration error',
      undefined,
      new Error('read failed'),
      false,
      '无法恢复登录状态，请重试',
    ],
    ['renders unauthenticated state', undefined, undefined, false, '登录或注册'],
    [
      'renders authenticated state',
      { accountId: 'acc_001', accessToken: 'opaque-token', expiresAt: 200_000 },
      undefined,
      false,
      '日程日历',
    ],
  ])(
    '%s',
    async (_name, session, readError, pending, expected) => {
      const controller = createController(session, readError, pending);
      render(<AppRoot authController={controller} />);

      await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
      expect(screen.queryByText('opaque-token')).toBeNull();
    },
    10_000,
  );

  it('enters the calendar after controller authentication without exposing the token', async () => {
    const controller = createController();
    render(<AppRoot authController={controller} />);

    await screen.findByLabelText('用户名');
    fireEvent.changeText(screen.getByLabelText('用户名'), 'timeflow_user');
    fireEvent.changeText(screen.getByLabelText('密码'), 'password123');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
    expect(screen.queryByText('登录或注册')).toBeNull();
    expect(screen.queryByText('opaque-token')).toBeNull();
  });

  it('can retry SQLite initialization after a failure', async () => {
    mockedOpenTimeflowDatabase
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({} as never);
    const controller = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
    });
    render(<AppRoot authController={controller} />);

    await waitFor(() => expect(screen.getByText('本地日程存储初始化失败')).toBeTruthy());
    fireEvent.press(screen.getByText('重试'));

    await waitFor(() => expect(mockedOpenTimeflowDatabase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
  });
});

function createController(
  session?: { accountId: string; accessToken: string; expiresAt: number },
  readError?: unknown,
  pending = false,
) {
  const store = new FakeAuthSessionStore();
  store.session = session;
  store.readError = readError;
  if (pending) {
    store.beforeRead = () => new Promise(() => undefined);
  }
  return new AuthController({
    authAccess: async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }),
    now: () => 100_000,
    store,
  });
}
