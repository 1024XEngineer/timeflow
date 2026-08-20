import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AppRoot } from '../../../src/app/AppRoot';
import {
  createAppServices,
  type AppServices,
} from '../../../src/app/composition/createAppServices';
import { createScheduleSnapshotPreparation } from '../../../src/app/composition/createScheduleSnapshotPreparation';
import { LocalScheduleWriter } from '../../../src/features/assistant/data/local/LocalScheduleWriter';
import type {
  ScheduleSnapshotBootstrapResult,
  ScheduleSnapshotBootstrapService,
} from '../../../src/features/sync/application';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { openTimeflowDatabase } from '../../../src/infrastructure/database';

jest.mock('../../../src/infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
}));
jest.mock('../../../src/app/composition/createScheduleSnapshotPreparation', () => ({
  createScheduleSnapshotPreparation: jest.fn(),
}));
jest.mock('../../../src/features/schedule/data', () => ({
  ScheduleLocalRepository: jest.fn().mockImplementation(() => ({
    getSchedule: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    listSchedules: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
  })),
}));
jest.mock('../../../src/features/schedule/application', () => ({
  SqliteScheduleClientService: jest.fn(),
}));
jest.mock('../../../src/features/assistant/data/local/LocalScheduleWriter', () => ({
  LocalScheduleWriter: jest.fn().mockImplementation(() => ({
    applyCommandResult: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  })),
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
const mockedCreateScheduleSnapshotPreparation =
  createScheduleSnapshotPreparation as jest.MockedFunction<
    typeof createScheduleSnapshotPreparation
  >;
let mockedEnsureLocalSnapshot: jest.MockedFunction<
  ScheduleSnapshotBootstrapService['ensureLocalSnapshot']
>;

beforeEach(() => {
  mockedOpenTimeflowDatabase.mockReset();
  mockedOpenTimeflowDatabase.mockResolvedValue({} as never);
  mockedEnsureLocalSnapshot = jest.fn<ScheduleSnapshotBootstrapService['ensureLocalSnapshot']>(
    async () => ({ status: 'skipped_local_data' }),
  );
  mockedCreateScheduleSnapshotPreparation.mockReset();
  mockedCreateScheduleSnapshotPreparation.mockReturnValue({
    // scheduleReader.refresh() (wired in AppRoot's ready-state effect) calls through to
    // these two on whatever repository the snapshot preparation hands back, so the stub
    // needs real methods now, not just an opaque {} -- see SqliteLocalScheduleReader.
    repository: {
      getSchedule: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      listSchedules: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
    },
    bootstrap: { ensureLocalSnapshot: mockedEnsureLocalSnapshot },
  } as never);
  jest.mocked(LocalScheduleWriter).mockClear();
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
      const services = createController(session, readError, pending);
      render(<AppRoot services={services} />);

      await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
      expect(screen.queryByText('opaque-token')).toBeNull();
    },
    10_000,
  );

  it('enters the calendar after controller authentication without exposing the token', async () => {
    const services = createController();
    render(<AppRoot services={services} />);

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
    const services = createController({
      accountId: 'acc_internal_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'restored_user',
    });
    render(<AppRoot services={services} />);

    await screen.findByText('restored_user');
    expect(screen.queryByText(/账号：/)).toBeNull();
    expect(screen.queryByText(/acc_internal_001/)).toBeNull();
    expect(screen.queryByText('opaque-token')).toBeNull();
  });

  it('waits for local snapshot preparation before rendering the calendar', async () => {
    const preparation = createDeferred<ScheduleSnapshotBootstrapResult>();
    mockedEnsureLocalSnapshot.mockReturnValueOnce(preparation.promise);
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });

    render(<AppRoot services={services} />);

    expect(await screen.findByText('正在准备日程')).toBeTruthy();
    expect(screen.queryByText('日程日历')).toBeNull();
    preparation.resolve({ status: 'applied' });
    expect(await screen.findByText('日程日历')).toBeTruthy();
  });

  it('shows a retryable sync error and retries the whole preparation', async () => {
    mockedEnsureLocalSnapshot
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
      .mockResolvedValueOnce({ status: 'applied' });
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });

    render(<AppRoot services={services} />);

    expect(await screen.findByText('日程同步失败')).toBeTruthy();
    fireEvent.press(screen.getByText('重试'));
    expect(await screen.findByText('日程日历')).toBeTruthy();
    expect(mockedEnsureLocalSnapshot).toHaveBeenCalledTimes(2);
  });

  it('leaves the sync route when protected access invalidates authentication', async () => {
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    const controller = services.auth.controller;
    mockedEnsureLocalSnapshot.mockImplementationOnce(async () => {
      await controller.invalidate('revoked');
      throw new Error('unauthenticated');
    });

    render(<AppRoot services={services} />);

    expect(await screen.findByText('登录')).toBeTruthy();
    expect(screen.queryByText('日程同步失败')).toBeNull();
  });

  it('ignores an old account preparation after the route is replaced', async () => {
    const oldPreparation = createDeferred<ScheduleSnapshotBootstrapResult>();
    mockedEnsureLocalSnapshot
      .mockReturnValueOnce(oldPreparation.promise)
      .mockResolvedValueOnce({ status: 'skipped_local_data' });
    const firstServices = createController({
      accountId: 'account-a',
      accessToken: 'token-a',
      expiresAt: 200_000,
      username: 'user_a',
    });
    const secondServices = createController({
      accountId: 'account-b',
      accessToken: 'token-b',
      expiresAt: 200_000,
      username: 'user_b',
    });
    const view = render(<AppRoot services={firstServices} />);
    await screen.findByText('正在准备日程');

    view.rerender(<AppRoot services={secondServices} />);

    expect(await screen.findByText('user_b')).toBeTruthy();
    const oldSignal = (mockedEnsureLocalSnapshot.mock.calls[0] as unknown[])[1] as
      AbortSignal | undefined;
    expect(oldSignal?.aborted).toBe(true);
    oldPreparation.resolve({ status: 'applied' });

    await waitFor(() => expect(screen.getByText('user_b')).toBeTruthy());
    expect(screen.queryByText('user_a')).toBeNull();
  });

  it('can retry SQLite initialization after a failure', async () => {
    mockedOpenTimeflowDatabase
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({} as never);
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    render(<AppRoot services={services} />);

    await waitFor(() => expect(screen.getByText('日程同步失败')).toBeTruthy());
    fireEvent.press(screen.getByText('重试'));

    await waitFor(() => expect(mockedOpenTimeflowDatabase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
    expect(screen.getByText('timeflow_user')).toBeTruthy();
    expect(screen.queryByText(/账号：/)).toBeNull();
  });

  it('can sign out when SQLite initialization fails', async () => {
    mockedOpenTimeflowDatabase.mockRejectedValue(new Error('database unavailable'));
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    const controller = services.auth.controller;
    render(<AppRoot services={services} />);

    await screen.findByText('日程同步失败');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('can sign out while SQLite initialization is pending', async () => {
    mockedOpenTimeflowDatabase.mockImplementation(() => new Promise(() => undefined));
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    const controller = services.auth.controller;
    render(<AppRoot services={services} />);

    await screen.findByText('正在准备日程');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('signs out from the authenticated account shell', async () => {
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    const controller = services.auth.controller;
    render(<AppRoot services={services} />);

    await screen.findByText('日程日历');
    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('binds the reminder SQLite adapters and detaches them on sign out', async () => {
    const services = createController({
      accountId: 'acc_001',
      accessToken: 'opaque-token',
      expiresAt: 200_000,
      username: 'timeflow_user',
    });
    const attachSchedules = jest.spyOn(services.schedules, 'attach');
    const detachSchedules = jest.spyOn(services.schedules, 'detach');
    const refreshSchedules = jest.spyOn(services.schedules, 'refresh').mockResolvedValue(undefined);
    const attachState = jest.spyOn(services.reminderState, 'attach');
    const detachState = jest.spyOn(services.reminderState, 'detach');

    render(<AppRoot services={services} />);

    await screen.findByText('日程日历');
    expect(attachSchedules).toHaveBeenCalledWith(expect.anything(), 'acc_001');
    expect(attachState).toHaveBeenCalledWith(expect.anything(), 'acc_001');
    expect(refreshSchedules).toHaveBeenCalledTimes(1);
    expect(LocalScheduleWriter).toHaveBeenCalledWith(expect.anything(), services.schedules);

    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(screen.getByText('登录')).toBeTruthy());
    expect(detachSchedules).toHaveBeenCalledTimes(1);
    expect(detachState).toHaveBeenCalledTimes(1);
  });
});

function createController(
  session?: { accountId: string; accessToken: string; expiresAt: number; username: string },
  readError?: unknown,
  pending = false,
): AppServices {
  const store = new FakeAuthSessionStore();
  store.session = session;
  store.readError = readError;
  if (pending) {
    store.beforeRead = () => new Promise(() => undefined);
  }
  const fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }),
  })) as unknown as typeof globalThis.fetch;
  return createAppServices({
    auth: {
      fetch,
      now: () => 100_000,
      store,
    },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
