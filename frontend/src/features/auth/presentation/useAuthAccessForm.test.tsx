import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { AuthAccess, AuthAccessResponse } from '../../../contracts/auth';
import { useAuthAccessForm } from './useAuthAccessForm';

const tokenResponse: AuthAccessResponse = {
  account_id: 'acc_001',
  access_token: 'access-token',
  expires_in: 3600,
};

describe('useAuthAccessForm', () => {
  it('clears only the edited field error', async () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    const { result } = renderHook(() => useAuthAccessForm({ authAccess }));

    await act(async () => result.current.submit());
    expect(result.current.errors).toEqual({
      password: '请输入密码',
      username: '请输入用户名',
    });

    act(() => result.current.updateField('username', 'timeflow_user'));
    expect(result.current.errors).toEqual({ password: '请输入密码' });
  });

  it('submits normalized credentials and forwards the authenticated account', async () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    const onAuthenticated = jest.fn();
    const { result } = renderHook(() => useAuthAccessForm({ authAccess, onAuthenticated }));

    act(() => {
      result.current.updateField('username', ' timeflow_user ');
      result.current.updateField('password', 'password123');
    });
    await act(async () => result.current.submit());

    expect(authAccess).toHaveBeenCalledWith({
      password: 'password123',
      username: 'timeflow_user',
    });
    expect(onAuthenticated).toHaveBeenCalledWith(tokenResponse);
  });

  it('submits even when no authenticated listener is registered', async () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    const { result } = renderHook(() => useAuthAccessForm({ authAccess }));

    act(() => {
      result.current.updateField('username', 'timeflow_user');
      result.current.updateField('password', 'password123');
    });
    await act(async () => result.current.submit());

    expect(authAccess).toHaveBeenCalledWith({
      password: 'password123',
      username: 'timeflow_user',
    });
  });
});
