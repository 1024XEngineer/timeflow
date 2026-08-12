import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  AuthAccessError,
  isAuthAccessResponse,
  type AuthAccessResponse,
} from '../../../../../src/contracts/auth';
import {
  ApiError,
  ApiResponseError,
  type ApiRequest,
} from '../../../../../src/infrastructure/network/client';
import { createAuthAccess } from '../../../../../src/features/auth/data/auth';

const credentials = { username: 'timeflow_user', password: 'password123' };
const response: AuthAccessResponse = {
  account_id: 'acc_001',
  access_token: 'access-token',
  expires_in: 3600,
};

afterEach(() => {
  jest.useRealTimers();
});

describe('createAuthAccess', () => {
  it('posts credentials to the unified access endpoint', async () => {
    const request = jest.fn(async () => response) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith('/auth/access', {
      body: JSON.stringify(credentials),
      auth: 'public',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: expect.anything(),
    });
  });

  it('exposes a documented business error code', async () => {
    const request = jest.fn(async () => {
      throw new ApiError(401, {
        error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });
    }) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('business', 'AUTH_INVALID_CREDENTIALS'),
    );
  });

  it('distinguishes a network failure', async () => {
    const request = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('network'),
    );
  });

  it('aborts an authentication request after 15 seconds', () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = jest.fn((_path: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<never>(() => undefined);
    }) as unknown as ApiRequest;

    void createAuthAccess(request)(credentials);
    jest.advanceTimersByTime(15_000);

    expect(requestSignal).toBeDefined();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('reports an aborted authentication request as a timeout', async () => {
    const request = jest.fn(async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('reports invalid success JSON as an invalid response', async () => {
    const request = jest.fn(async () => {
      throw new ApiResponseError(200);
    }) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('invalid_response'),
    );
  });

  it('rejects an invalid token response', async () => {
    const request = jest.fn(async () => ({ account_id: 'acc_001' })) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('invalid_response'),
    );
  });

  it('rejects a whitespace-only account id', async () => {
    const request = jest.fn(async () => ({
      ...response,
      account_id: '   ',
    })) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('invalid_response'),
    );
  });

  it('rejects a whitespace-only access token', async () => {
    const request = jest.fn(async () => ({
      ...response,
      access_token: '   ',
    })) as unknown as ApiRequest;

    await expect(createAuthAccess(request)(credentials)).rejects.toEqual(
      new AuthAccessError('invalid_response'),
    );
  });
});

describe('isAuthAccessResponse', () => {
  it('accepts the fixed 3600-second token response', () => {
    expect(isAuthAccessResponse(response)).toBe(true);
  });

  it('requires every response field to be an own property', () => {
    const accountIdDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'account_id');
    const accessTokenDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'access_token',
    );
    const expiresInDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'expires_in');

    try {
      // eslint-disable-next-line no-extend-native -- 受控原型污染回归测试；finally 会恢复并隔离全局状态。
      Object.defineProperties(Object.prototype, {
        account_id: { configurable: true, value: response.account_id },
        access_token: { configurable: true, value: response.access_token },
        expires_in: { configurable: true, value: response.expires_in },
      });

      expect(isAuthAccessResponse({
        access_token: response.access_token,
        expires_in: response.expires_in,
      })).toBe(false);
      expect(isAuthAccessResponse({
        account_id: response.account_id,
        expires_in: response.expires_in,
      })).toBe(false);
      expect(isAuthAccessResponse({
        account_id: response.account_id,
        access_token: response.access_token,
      })).toBe(false);
    } finally {
      restoreObjectPrototypeProperty('account_id', accountIdDescriptor);
      restoreObjectPrototypeProperty('access_token', accessTokenDescriptor);
      restoreObjectPrototypeProperty('expires_in', expiresInDescriptor);
    }
  });

  it.each([0, 3599, 3601, '3600', Infinity])('rejects expires_in %p', (expires_in) => {
    expect(isAuthAccessResponse({ ...response, expires_in })).toBe(false);
  });

  it.each([
    { ...response, account_id: '' },
    { ...response, account_id: '   ' },
    { ...response, access_token: '' },
    { ...response, access_token: '   ' },
    Object.assign([] as unknown[], response),
  ])('rejects invalid response fields and shapes', (invalidResponse) => {
    expect(isAuthAccessResponse(invalidResponse)).toBe(false);
  });
});

function restoreObjectPrototypeProperty(
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    // eslint-disable-next-line no-extend-native -- 恢复受控原型污染；try/finally 保证测试隔离。
    Object.defineProperty(Object.prototype, property, descriptor);
    return;
  }

  Reflect.deleteProperty(Object.prototype, property);
}
