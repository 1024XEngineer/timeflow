import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { AuthAccessResponse } from '../../../src/contracts/auth';
import { accessAuth } from '../../../src/features/auth/data/auth';
import { AppRoot } from '../../../src/app/AppRoot';

jest.mock('../../../src/features/auth/data/auth', () => ({ accessAuth: jest.fn() }));
jest.mock('../../../src/infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
}));
jest.mock('../../../src/features/schedule/data', () => ({ ScheduleLocalRepository: jest.fn() }));
jest.mock('../../../src/features/schedule/application', () => ({
  SqliteScheduleClientService: jest.fn(),
}));
jest.mock('../../../src/features/schedule/presentation/ScheduleCalendarScreen', () => ({
  ScheduleCalendarScreen: () => {
    const { Text: NativeText } = jest.requireActual(
      'react-native',
    ) as typeof import('react-native');
    return <NativeText>日程日历</NativeText>;
  },
}));

const mockedAccessAuth = accessAuth as jest.MockedFunction<typeof accessAuth>;
const tokenResponse: AuthAccessResponse = {
  account_id: 'acc_001',
  access_token: 'access-token',
  expires_in: 3600,
};

beforeEach(() => {
  mockedAccessAuth.mockReset();
});

describe('AppRoot', () => {
  it('enters the calendar after authentication without exposing the token', async () => {
    mockedAccessAuth.mockResolvedValue(tokenResponse);
    render(<AppRoot />);
    fireEvent.changeText(screen.getByPlaceholderText('输入用户名'), 'timeflow_user');
    fireEvent.changeText(screen.getByPlaceholderText('输入密码'), 'password123');
    fireEvent.press(screen.getByText('继续'));
    await waitFor(() => expect(screen.getByText('日程日历')).toBeTruthy());
    expect(screen.queryByText('access-token')).toBeNull();
  });

  it('can retry SQLite initialization after a failure', async () => {
    const { openTimeflowDatabase } = jest.requireMock(
      '../../../src/infrastructure/database',
    ) as {
      openTimeflowDatabase: jest.MockedFunction<() => Promise<unknown>>;
    };
    openTimeflowDatabase.mockReset();
    openTimeflowDatabase
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({});
    mockedAccessAuth.mockResolvedValue(tokenResponse);
    render(<AppRoot />);
    fireEvent.changeText(screen.getByPlaceholderText('输入用户名'), 'timeflow_user');
    fireEvent.changeText(screen.getByPlaceholderText('输入密码'), 'password123');
    fireEvent.press(screen.getByText('继续'));
    await waitFor(() => expect(screen.getByText('本地日程存储初始化失败')).toBeTruthy());
    fireEvent.press(screen.getByText('重试'));
    await waitFor(() => expect(openTimeflowDatabase).toHaveBeenCalledTimes(2));
  });
});
