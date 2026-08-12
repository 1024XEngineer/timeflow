import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { AuthAccessError, type AuthAccessResponse } from '../contracts/auth';
import { ApiError, ApiResponseError, type ApiRequest } from '../infrastructure/network/client';
import { createAuthAccess } from './auth';

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
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: expect.anything(),
    });
  });

  it('exposes a documented business error code', async () => {
    const request = jest.fn(async () => {
      throw new ApiError(401, { error: { code: 'AUTH_INVALID_CREDENTIALS' } });
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
