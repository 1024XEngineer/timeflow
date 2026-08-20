import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Dimensions, Image, Keyboard, StyleSheet, type KeyboardEvent } from 'react-native';

import { AuthAccessError, type AuthAccess } from '../../../src/contracts/auth';
import { AuthController } from '../../../src/features/auth/application';
import { AuthProvider } from '../../../src/features/auth/presentation/AuthProvider';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { LoginScreen } from '../../../src/screens/LoginScreen';
import { colors } from '../../../src/shared/ui/theme';

function renderLogin(authAccess: AuthAccess) {
  const controller = new AuthController({
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
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('shows the left-aligned Timeflow wordmark and login copy without the old marks', () => {
    renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    const brand = screen.getByTestId('brand-region');
    expect(StyleSheet.flatten(brand.props.style)).toMatchObject({
      alignSelf: 'flex-start',
      flexDirection: 'row',
    });
    expect(within(brand).getByText('Time')).toBeTruthy();
    expect(within(brand).getByText('flow')).toBeTruthy();
    expect(within(brand).queryByText('T')).toBeNull();
    expect(within(brand).queryByText('Timeflow')).toBeNull();
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);

    expect(screen.getByText('登录')).toBeTruthy();
    expect(screen.getByText('首次使用会自动创建账号。')).toBeTruthy();
    expect(screen.getByText('你的日程只属于你')).toBeTruthy();
    expect(screen.queryByText('登录或注册')).toBeNull();
    expect(screen.queryByText('首次使用会自动创建账号，已有账号将直接登录。')).toBeNull();
    expect(screen.queryByText('你的日程只属于你，我们会认真保护账号信息。')).toBeNull();
  });

  it('masks the password field', () => {
    renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    expect(screen.getByLabelText('密码').props.secureTextEntry).toBe(true);
  });

  it('focuses fields, advances to the password, and lifts with the IME', () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
      listeners.set(event, listener as (event: KeyboardEvent) => void);
      return {
        remove() {
          listeners.delete(event);
        },
      } as ReturnType<typeof Keyboard.addListener>;
    });
    jest.spyOn(Keyboard, 'scheduleLayoutAnimation').mockImplementation(() => {});

    renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    const username = screen.getByLabelText('用户名');
    const password = screen.getByLabelText('密码');
    fireEvent(username, 'focus');
    expect(StyleSheet.flatten(username.props.style)).toMatchObject({ borderColor: colors.focus });
    fireEvent(username, 'submitEditing');
    fireEvent(username, 'blur');
    fireEvent(password, 'focus');
    expect(StyleSheet.flatten(password.props.style)).toMatchObject({ borderColor: colors.focus });
    fireEvent(password, 'blur');
    fireEvent(screen.getByRole('button', { name: '继续' }), 'pressIn');

    const windowHeight = Dimensions.get('window').height;
    act(() => {
      listeners.get('keyboardWillChangeFrame')?.({
        duration: 0,
        easing: 'keyboard',
        endCoordinates: {
          height: 300,
          screenX: 0,
          screenY: windowHeight - 300,
          width: 400,
        },
      });
    });
    expect(screen.getByTestId('login-ime-lift')).toHaveStyle({ transform: [{ translateY: -300 }] });
  });

  it('disables fields and the submit control while authenticating', async () => {
    let release!: (value: { access_token: string; account_id: string; expires_in: number }) => void;
    renderLogin(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fillValidForm();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: '继续' }));
    });

    await waitFor(() => expect(screen.getByText('提交中…')).toBeTruthy());
    expect(screen.getByLabelText('用户名').props.editable).toBe(false);
    expect(screen.getByLabelText('密码').props.editable).toBe(false);
    expect(screen.getByRole('button', { name: '提交中…' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await act(async () => {
      release({ access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 });
    });
  });

  it('keeps the login sheet unshifted until the IME covers the window', () => {
    renderLogin(async () => ({
      access_token: 'opaque-token',
      account_id: 'acc_001',
      expires_in: 3600,
    }));

    expect(screen.getByTestId('login-ime-lift')).toHaveStyle({ transform: [{ translateY: 0 }] });
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
});
