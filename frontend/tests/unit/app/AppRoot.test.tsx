import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AppRoot } from '../../../src/app/AppRoot';
import { AuthController } from '../../../src/features/auth/application';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { openTimeflowDatabase } from '../../../src/infrastructure/database';

jest.mock('../../../src/infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
}));
jest.mock('../../../src/features/schedule/data', () => ({ ScheduleLocalRepository: jest.fn() }));
jest.mock('../../../src/features/schedule/application', () => ({
  SqliteScheduleClientService: jest.fn(),
}));
jest.mock('../../../src/features/schedule/presentation/ScheduleCalendarScreen', () => ({
  ScheduleCalendarScreen: ({
    isSigningOut,
    onSignOut,
    username,
  }: {
    isSigningOut: boolean;
    onSignOut: () => Promise<void>;
    username: string;
  }) => {
    const { Pressable, Text, View } = jest.requireActual(
      'react-native',
    ) as typeof import('react-native');
    return (
      <View>
        <Text>日程日历</Text>
        <Text>{username}</Text>
        <Pressable
          accessibilityLabel="退出登录"
          accessibilityRole="button"
          disabled={isSigningOut}
          onPress={() => void onSignOut()}
        />
      </View>
    );
  },
}));
// 语音助手这几个真实实现都要接原生模块（麦克风/播放/定位），测试环境没有对应的
// native module 注册，AppRoot 一 import 到就会在模块加载阶段直接抛错；跟上面的
// SQLite/日历屏一样，只测装配逻辑，不需要真实实现。
jest.mock('../../../src/features/assistant/data/audio/ExpoAudioCapture', () => ({
  ExpoAudioCapture: jest.fn().mockImplementation(() => ({
    requestPermission: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    start: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../../src/features/assistant/data/audio/ExpoAudioPlayback', () => ({
  ExpoAudioPlayback: jest.fn(),
}));
jest.mock('../../../src/infrastructure/location/ExpoLocationProvider', () => ({
  ExpoLocationProvider: jest.fn(),
}));
jest.mock('../../../src/features/assistant/presentation/AssistantVoiceOverlay', () => ({
  AssistantVoiceOverlay: () => null,
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
    ['renders unauthenticated state', undefined, undefined, false, '登录'],
    [
      'renders authenticated state',
      {
        accountId: 'acc_internal_001',
        accessToken: 'opaque-token',
        expiresAt: 200_000,
        username: 'timeflow_user',
      },
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
    fireEvent.changeText(screen.getByLabelText('用户名'), '  timeflow_user  ');
    fireEvent.changeText(screen.getByLabelText('密码'), 'password123');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
    expect(screen.getByText('timeflow_user')).toBeTruthy();
    expect(screen.queryByText(/账号：/)).toBeNull();
    expect(screen.queryByText(/acc_001/)).toBeNull();
    expect(screen.queryByText('登录')).toBeNull();
    expect(screen.queryByText('opaque-token')).toBeNull();
  });

  it('shows the restored username without rendering the internal account id', async () => {
    const controller = createController({
      accountId: 'acc_internal_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'restored_user',
    });
    render(<AppRoot authController={controller} />);

    await screen.findByText('restored_user');
    expect(screen.queryByText(/账号：/)).toBeNull();
    expect(screen.queryByText(/acc_internal_001/)).toBeNull();
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
      username: 'timeflow_user',
    });
    render(<AppRoot authController={controller} />);

    await waitFor(() => expect(screen.getByText('本地日程存储初始化失败')).toBeTruthy());
    fireEvent.press(screen.getByText('重试'));

    await waitFor(() => expect(mockedOpenTimeflowDatabase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
    expect(screen.getByText('timeflow_user')).toBeTruthy();
    expect(screen.queryByText(/账号：/)).toBeNull();
  });

  it('can sign out when SQLite initialization fails', async () => {
    mockedOpenTimeflowDatabase.mockRejectedValue(new Error('database unavailable'));
    const controller = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    render(<AppRoot authController={controller} />);

    await screen.findByText('本地日程存储初始化失败');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('can sign out while SQLite initialization is pending', async () => {
    mockedOpenTimeflowDatabase.mockImplementation(() => new Promise(() => undefined));
    const controller = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    render(<AppRoot authController={controller} />);

    await screen.findByText('正在准备日程');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('signs out from the authenticated account shell', async () => {
    const controller = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    render(<AppRoot authController={controller} />);

    await screen.findByText('日程日历');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });
});

function createController(
  session?: { accountId: string; accessToken: string; expiresAt: number; username: string },
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
