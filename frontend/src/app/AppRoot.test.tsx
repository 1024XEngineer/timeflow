import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { accessAuth } from '../api/auth';
import type { AuthAccessResponse } from '../contracts/auth';
import { AppRoot } from './AppRoot';

jest.mock('../api/auth', () => ({ accessAuth: jest.fn() }));
jest.mock('../infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
}));
jest.mock('../features/schedule/data', () => ({ ScheduleLocalRepository: jest.fn() }));
jest.mock('../features/schedule/application', () => ({ SqliteScheduleClientService: jest.fn() }));
jest.mock('../features/schedule/presentation/ScheduleCalendarScreen', () => ({
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
});
