import { afterEach, describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { AuthAccessError, type AuthAccess } from '../../../src/contracts/auth';
import { AuthController } from '../../../src/features/auth/application';
import { AuthProvider } from '../../../src/features/auth/presentation/AuthProvider';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { LoginScreen } from '../../../src/screens/LoginScreen';

function renderLogin(authAccess: AuthAccess, allowLocalPreview = false) {
  const controller = new AuthController({
    allowLocalPreview,
    authAccess,
    now: () => 100_000,
    store: new FakeAuthSessionStore(),
  });
  render(
    <AuthProvider controller={controller}>
      <LoginScreen />
    </AuthProvider>,
  );
  return controller;
}

function fillValidForm() {
  fireEvent.changeText(screen.getByLabelText('用户名'), ' timeflow_user ');
  fireEvent.changeText(screen.getByLabelText('密码'), 'password123');
}

describe('LoginScreen', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  it('validates empty fields without authenticating', async () => {
    const controller = renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    expect(screen.getByText('请输入用户名')).toBeTruthy();
    expect(screen.getByText('请输入密码')).toBeTruthy();
    expect(controller.getState().status).toBe('unauthenticated');
  });

  it('submits normalized credentials through the controller', async () => {
    let received: unknown;
    const controller = renderLogin(async (credentials) => {
      received = credentials;
      return { access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 };
    });
    fillValidForm();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    await waitFor(() => expect(controller.getState().status).toBe('authenticated'));
    expect(received).toEqual({ password: 'password123', username: 'timeflow_user' });
  });

  it.each([
    [new AuthAccessError('business', 'AUTH_INVALID_CREDENTIALS'), '用户名或密码错误'],
    [new AuthAccessError('business', 'AUTH_RATE_LIMITED'), '请求过于频繁，请稍后重试'],
    [new AuthAccessError('network'), '无法连接服务器，请检查网络后重试'],
    [new AuthAccessError('timeout'), '请求超时，请稍后重试'],
  ])('shows the safe error for %p', async (error, message) => {
    renderLogin(async () => {
      throw error;
    });
    fillValidForm();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('hides local preview off web even when the composition flag is on', () => {
    Platform.OS = 'android';
    renderLogin(async () => {
      return { access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 };
    }, true);

    expect(screen.queryByRole('button', { name: '进入本地预览' })).toBeNull();
  });

  it('does not show local preview on web when the composition flag is off', () => {
    Platform.OS = 'web';
    renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    expect(screen.queryByRole('button', { name: '进入本地预览' })).toBeNull();
  });

  it('shows local preview only on web and enters it without submitting credentials', async () => {
    Platform.OS = 'web';
    let accessed = false;
    const controller = renderLogin(async () => {
      accessed = true;
      return { access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 };
    }, true);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '进入本地预览' }));
    });

    await waitFor(() => expect(controller.getState().status).toBe('authenticated'));
    expect(accessed).toBe(false);
    expect(controller.getViewState()).toMatchObject({
      accountId: 'preview_local',
      username: '本地预览',
    });
  });
});
