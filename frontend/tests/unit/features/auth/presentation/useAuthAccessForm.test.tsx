import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { AuthController } from '../../../../../src/features/auth/application';
import { AuthProvider } from '../../../../../src/features/auth/presentation/AuthProvider';
import { useAuthAccessForm } from '../../../../../src/features/auth/presentation/useAuthAccessForm';
import { FakeAuthSessionStore } from '../../../../../src/features/auth/testing/FakeAuthSessionStore';

describe('useAuthAccessForm', () => {
  it('clears only the edited field error', async () => {
    const controller = createController();
    const { result } = renderHook(() => useAuthAccessForm(), {
      wrapper: ({ children }) => <AuthProvider controller={controller}>{children}</AuthProvider>,
    });

    await act(async () => result.current.submit());
    expect(result.current.errors).toEqual({ password: '请输入密码', username: '请输入用户名' });

    act(() => result.current.updateField('username', 'timeflow_user'));
    expect(result.current.errors).toEqual({ password: '请输入密码' });
  });
});

function createController() {
  return new AuthController({
    authAccess: async () => ({ access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 }),
    now: () => 100_000,
    store: new FakeAuthSessionStore(),
  });
}
