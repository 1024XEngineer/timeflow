import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { accessAuth } from '../api/auth';
import type { AuthAccessResponse } from '../contracts/auth';
import { AppRoot } from './AppRoot';

jest.mock('../api/auth', () => ({
  accessAuth: jest.fn(),
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
  it('leaves the login form after authentication without exposing the token', async () => {
    mockedAccessAuth.mockResolvedValue(tokenResponse);
    render(<AppRoot />);

    fireEvent.changeText(screen.getByLabelText('用户名'), 'timeflow_user');
    fireEvent.changeText(screen.getByLabelText('密码'), 'password123');
    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => {
      expect(screen.getByText('登录成功')).toBeTruthy();
    });
    expect(screen.queryByText('登录或注册')).toBeNull();
    expect(screen.getByText('账号：acc_001')).toBeTruthy();
    expect(screen.queryByText('access-token')).toBeNull();
  });
});
