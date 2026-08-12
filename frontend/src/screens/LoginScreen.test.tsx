import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AuthAccessError, type AuthAccess, type AuthAccessResponse } from '../contracts/auth';
import { LoginScreen } from './LoginScreen';

const tokenResponse: AuthAccessResponse = {
  account_id: 'acc_001',
  access_token: 'access-token',
  expires_in: 3600,
};

function fillValidForm() {
  fireEvent.changeText(screen.getByLabelText('用户名'), ' timeflow_user ');
  fireEvent.changeText(screen.getByLabelText('密码'), 'password123');
}

describe('LoginScreen', () => {
  it('renders the unified login and registration controls', () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    render(<LoginScreen authAccess={authAccess} />);

    expect(screen.getByText('登录或注册')).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy();
  });

  it('validates empty fields without sending a request', () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    render(<LoginScreen authAccess={authAccess} />);

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    expect(screen.getByText('请输入用户名')).toBeTruthy();
    expect(screen.getByText('请输入密码')).toBeTruthy();
    expect(authAccess).not.toHaveBeenCalled();
  });

  it('submits trimmed credentials and forwards the token response', async () => {
    const authAccess: AuthAccess = jest.fn(async () => tokenResponse);
    const onAuthenticated = jest.fn();
    render(<LoginScreen authAccess={authAccess} onAuthenticated={onAuthenticated} />);
    fillValidForm();

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => {
      expect(authAccess).toHaveBeenCalledWith({
        username: 'timeflow_user',
        password: 'password123',
      });
      expect(onAuthenticated).toHaveBeenCalledWith(tokenResponse);
    });
  });

  it('disables the form while submitting', async () => {
    const authAccess: AuthAccess = jest.fn(() => new Promise<AuthAccessResponse>(() => undefined));
    render(<LoginScreen authAccess={authAccess} />);
    fillValidForm();

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '提交中…' }).props.accessibilityState.disabled,
      ).toBe(true);
      expect(screen.getByLabelText('用户名').props.editable).toBe(false);
      expect(screen.getByLabelText('密码').props.editable).toBe(false);
    });
  });

  it('shows a business error without reporting success', async () => {
    const authAccess: AuthAccess = jest.fn(async () => {
      throw new AuthAccessError('business', 'AUTH_INVALID_CREDENTIALS');
    });
    const onAuthenticated = jest.fn();
    render(<LoginScreen authAccess={authAccess} onAuthenticated={onAuthenticated} />);
    fillValidForm();

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByText('用户名或密码错误')).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('shows a connection error without reporting success', async () => {
    const authAccess: AuthAccess = jest.fn(async () => {
      throw new AuthAccessError('network');
    });
    const onAuthenticated = jest.fn();
    render(<LoginScreen authAccess={authAccess} onAuthenticated={onAuthenticated} />);
    fillValidForm();

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByText('无法连接服务器，请检查网络后重试')).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('shows a timeout error and re-enables the form', async () => {
    const authAccess: AuthAccess = jest.fn(async () => {
      throw new AuthAccessError('timeout' as never);
    });
    render(<LoginScreen authAccess={authAccess} />);
    fillValidForm();

    fireEvent.press(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByText('请求超时，请稍后重试')).toBeTruthy();
    expect(screen.getByLabelText('用户名').props.editable).toBe(true);
    expect(screen.getByLabelText('密码').props.editable).toBe(true);
    expect(screen.getByRole('button', { name: '继续' }).props.accessibilityState.disabled).toBe(
      false,
    );
  });
});
