import { describe, expect, it } from '@jest/globals';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';

import { createAuthRuntime } from '../../src/app/authRuntime';
import { FakeAuthSessionStore } from '../fakes/FakeAuthSessionStore';
import { API_BASE_URL } from '../../src/infrastructure/network/client';

describe('real authentication backend', () => {
  it('creates an account, signs in again, and signs out through the frontend runtime', async () => {
    expect(API_BASE_URL).toBe(process.env['EXPO_PUBLIC_API_URL']?.replace(/\/$/, ''));
    const store = new FakeAuthSessionStore();
    const runtime = createAuthRuntime({ fetch: fetchWithNodeHttp, store });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const credentials = {
      password: `Live-${suffix}`,
      username: `live_${suffix}`,
    };

    await runtime.controller.initialize();
    await runtime.controller.authenticate(credentials);
    const created = runtime.controller.getViewState();
    expect(created).toEqual({
      accountId: expect.any(String),
      status: 'authenticated',
      username: credentials.username,
    });

    await runtime.controller.authenticate(credentials);
    const existing = runtime.controller.getViewState();
    expect(existing).toEqual(created);

    await runtime.invalidationCoordinator.invalidate('revoked');
    expect(runtime.controller.getViewState()).toEqual({ status: 'unauthenticated' });
    expect(store.session).toBeUndefined();
  });
});

/** jest-expo 会替换全局 fetch；live 测试经由生产注入接缝使用真实 Node HTTP。 */
const fetchWithNodeHttp: typeof globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  const headers = Object.fromEntries(new Headers(init.headers).entries());

  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, { headers, method: init.method }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const status = incoming.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          json: async () => JSON.parse(body) as unknown,
          ok: status >= 200 && status < 300,
          status,
        } as Response);
      });
    });
    const abort = () => {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      outgoing.destroy(error);
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    outgoing.once('close', () => init.signal?.removeEventListener('abort', abort));
    outgoing.on('error', reject);
    if (typeof init.body === 'string') {
      outgoing.write(init.body);
    } else if (init.body != null) {
      outgoing.destroy(new TypeError('Live auth test only supports string request bodies'));
      return;
    }
    outgoing.end();
  });
};
