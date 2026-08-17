import { describe, expect, it, jest } from '@jest/globals';

import {
  ApiError,
  ApiUnauthenticatedError,
  createApiClient,
  type ApiRequest,
  type ApiRequestInit,
} from '../../../../src/infrastructure/network/client';

type ClientCase = readonly [string, ApiRequestInit, string | undefined, number, unknown, boolean];

describe('createApiClient', () => {
  it.each<ClientCase>([
    [
      'public removes caller authorization',
      { auth: 'public', headers: { authorization: 'Bearer stale', 'X-Request-Id': 'request-1' } },
      undefined,
      200,
      { ok: true },
      false,
    ],
    [
      'protected adds the opaque token',
      { auth: 'protected', headers: { 'X-Request-Id': 'request-1' } },
      'opaque-token',
      200,
      { ok: true },
      false,
    ],
    [
      'protected invalidates on AUTH_REQUIRED 401',
      { auth: 'protected' },
      'opaque-token',
      401,
      { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } },
      true,
    ],
    [
      'protected invalidates on AUTH_INVALID_TOKEN 401',
      { auth: 'protected' },
      'opaque-token',
      401,
      { error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid token' } },
      true,
    ],
    [
      'unknown 401 preserves the session',
      { auth: 'protected' },
      'opaque-token',
      401,
      { error: { code: 'AUTH_UNKNOWN', message: 'Unknown' } },
      false,
    ],
    [
      'non-401 token code preserves the session',
      { auth: 'protected' },
      'opaque-token',
      500,
      { error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid token' } },
      false,
    ],
  ])('%s', async (_name, init, token, status, body, shouldInvalidate) => {
    const request = createRequest(status, body, token);

    if (status === 200) {
      await expect(request.client<{ ok: boolean }>('/resource', init)).resolves.toEqual(body);
    } else {
      await expect(request.client('/resource', init)).rejects.toEqual(new ApiError(status, body));
    }

    const headers = new Headers(request.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe(
      init.auth === 'public' ? null : 'Bearer opaque-token',
    );
    expect(headers.get('X-Request-Id')).toBe(new Headers(init.headers).get('X-Request-Id'));
    expect(request.invalidate).toHaveBeenCalledTimes(shouldInvalidate ? 1 : 0);
  });

  it('does not revoke when the coordinator suppresses unauthenticated cleanup', async () => {
    const body = { error: { code: 'AUTH_INVALID_TOKEN', message: 'Expired' } };
    const request = createRequest(401, body, 'opaque-token', false, false);

    await expect(request.client('/resource', { auth: 'protected' })).rejects.toEqual(
      new ApiError(401, body),
    );
    expect(request.invalidate).not.toHaveBeenCalled();
  });

  it('does not issue protected requests without a token or while invalidating', async () => {
    for (const invalidating of [false, true]) {
      const request = createRequest(200, { ok: true }, undefined, invalidating);
      await expect(request.client('/resource', { auth: 'protected' })).rejects.toBeInstanceOf(
        ApiUnauthenticatedError,
      );
      expect(request.fetch).not.toHaveBeenCalled();
    }
  });
});

function createRequest(
  status: number,
  body: unknown,
  token: string | undefined,
  invalidating = false,
  shouldInvalidateOnUnauthenticated = true,
) {
  const fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as jest.MockedFunction<typeof global.fetch>;
  const invalidate = jest.fn(async () => undefined);
  const client: ApiRequest = createApiClient({
    fetch,
    invalidationCoordinator: {
      getAccessToken: async () => token,
      invalidate,
      isInvalidating: () => invalidating,
      shouldInvalidateOnUnauthenticated: () => shouldInvalidateOnUnauthenticated,
    },
  });
  return { client, fetch, invalidate };
}
