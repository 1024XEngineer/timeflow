import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { API_BASE_URL, ApiError, apiFetch } from './client';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('apiFetch', () => {
  it('defaults to the versioned API prefix when the environment variable is absent', () => {
    const configuredUrl = process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_API_URL;

    try {
      jest.isolateModules(() => {
        const isolatedClient = jest.requireActual<typeof import('./client')>('./client');

        expect(isolatedClient.API_BASE_URL).toBe('http://127.0.0.1:8000/api/v1');
      });
    } finally {
      process.env.EXPO_PUBLIC_API_URL = configuredUrl;
    }
  });

  it('returns the parsed JSON response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

    await expect(apiFetch<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/health`, undefined);
  });

  it('rejects a successful response whose body is not valid JSON', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    })) as unknown as typeof fetch;

    await expect(apiFetch('/auth/access')).rejects.toThrow(
      'API response was not valid JSON for status 200',
    );
  });

  it('preserves the status and body of an HTTP error', async () => {
    const body = { error: { code: 'AUTH_INVALID_CREDENTIALS' } };
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => body,
    })) as unknown as typeof fetch;

    await expect(apiFetch('/auth/access')).rejects.toEqual(new ApiError(401, body));
  });
});
