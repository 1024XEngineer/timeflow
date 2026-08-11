import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { API_BASE_URL, ApiError, apiFetch } from './client';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('apiFetch', () => {
  it('returns the parsed JSON response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

    await expect(apiFetch<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/health`, undefined);
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
