import { describe, expect, it, jest } from '@jest/globals';

import { AuthSessionCleanupRequiredError } from '../../../../../src/features/auth/application/interfaces';
import {
  SecureAuthSessionStore,
  type SecureStoreClient,
} from '../../../../../src/features/auth/data/SecureAuthSessionStore';
import { encodeAuthSessionRecord } from '../../../../../src/features/auth/data/authSessionRecord';

const sessionKey = 'timeflow.auth.session.v1';
const now = 1_000_000;
const session = {
  accountId: 'acc_001',
  accessToken: 'opaque-token-value',
  expiresAt: now + 30_001,
  username: 'timeflow_user',
};

describe('SecureAuthSessionStore', () => {
  it('returns undefined when secure storage is available but has no record', async () => {
    const client = createClient();
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.read()).resolves.toBeUndefined();
    expect(client.isAvailableAsync).toHaveBeenCalledTimes(1);
    expect(client.getItemAsync).toHaveBeenCalledWith(sessionKey);
  });

  it('reads a valid session through the shared record codec', async () => {
    const client = createClient();
    client.getItemAsync.mockResolvedValue(encodeAuthSessionRecord(session));
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.read()).resolves.toEqual(session);
    expect(client.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('encodes a session and writes it under the fixed key', async () => {
    const client = createClient();
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.write(session)).resolves.toBeUndefined();
    expect(client.setItemAsync).toHaveBeenCalledWith(sessionKey, encodeAuthSessionRecord(session));
  });

  it('clears the fixed key', async () => {
    const client = createClient();
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.clear()).resolves.toBeUndefined();
    expect(client.deleteItemAsync).toHaveBeenCalledWith(sessionKey);
  });

  it.each(['read', 'write', 'clear'] as const)(
    'fails %s with a fixed redacted error when secure storage is unavailable',
    async (operation) => {
      const client = createClient();
      client.isAvailableAsync.mockResolvedValue(false);
      const store = new SecureAuthSessionStore(client, () => now);

      const result = operation === 'write' ? store.write(session) : store[operation]();

      await expect(result).rejects.toMatchObject({
        message: 'Secure authentication session storage is unavailable',
      });
      expect(client.getItemAsync).not.toHaveBeenCalled();
      expect(client.setItemAsync).not.toHaveBeenCalled();
      expect(client.deleteItemAsync).not.toHaveBeenCalled();
    },
  );

  it('propagates availability-check failures unchanged', async () => {
    const failure = new Error('availability failure');
    const client = createClient();
    client.isAvailableAsync.mockRejectedValue(failure);
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.read()).rejects.toBe(failure);
  });

  it('propagates ordinary read failures unchanged', async () => {
    const failure = new Error('read failure');
    const client = createClient();
    client.getItemAsync.mockRejectedValue(failure);
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.read()).rejects.toBe(failure);
  });

  it('propagates ordinary write failures unchanged', async () => {
    const failure = new Error('write failure');
    const client = createClient();
    client.setItemAsync.mockRejectedValue(failure);
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.write(session)).rejects.toBe(failure);
  });

  it('propagates ordinary clear failures unchanged', async () => {
    const failure = new Error('clear failure');
    const client = createClient();
    client.deleteItemAsync.mockRejectedValue(failure);
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.clear()).rejects.toBe(failure);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a v1 record', JSON.stringify({ version: 1, session })],
    ['an unknown version', JSON.stringify({ version: 3, session })],
    [
      'an expired session',
      JSON.stringify({ version: 2, session: { ...session, expiresAt: now + 30_000 } }),
    ],
  ])('deletes %s and returns undefined', async (_description, rawRecord) => {
    const client = createClient();
    client.getItemAsync.mockResolvedValue(rawRecord);
    const store = new SecureAuthSessionStore(client, () => now);

    await expect(store.read()).resolves.toBeUndefined();
    expect(client.deleteItemAsync).toHaveBeenCalledWith(sessionKey);
  });

  it('cleans stored sessions whose required fields only exist on Object.prototype', async () => {
    const fields = ['accountId', 'accessToken', 'expiresAt', 'username'] as const;
    const descriptors = new Map(
      fields.map((field) => [field, Object.getOwnPropertyDescriptor(Object.prototype, field)]),
    );

    try {
      // eslint-disable-next-line no-extend-native -- 受控原型污染回归测试；finally 会恢复并隔离全局状态。
      Object.defineProperties(Object.prototype, {
        accountId: { configurable: true, value: session.accountId, writable: true },
        accessToken: { configurable: true, value: session.accessToken, writable: true },
        expiresAt: { configurable: true, value: session.expiresAt, writable: true },
        username: { configurable: true, value: session.username, writable: true },
      });

      for (const missingField of fields) {
        const storedSession: Record<string, unknown> = { ...session };
        delete storedSession[missingField];
        const client = createClient();
        client.getItemAsync.mockResolvedValue(
          JSON.stringify({ version: 2, session: storedSession }),
        );
        const store = new SecureAuthSessionStore(client, () => now);

        await expect(store.read()).resolves.toBeUndefined();
        expect(client.deleteItemAsync).toHaveBeenCalledWith(sessionKey);
      }
    } finally {
      for (const field of fields) {
        restoreObjectPrototypeProperty(field, descriptors.get(field));
      }
    }
  });

  it('throws only a fresh redacted typed error when invalid-record cleanup fails', async () => {
    const sensitiveRecord = '{"accessToken":"raw-secret-sentinel"';
    const cleanupFailure = new Error('native-secret-sentinel');
    const client = createClient();
    client.getItemAsync.mockResolvedValue(sensitiveRecord);
    client.deleteItemAsync.mockRejectedValue(cleanupFailure);
    const store = new SecureAuthSessionStore(client, () => now);

    const error = await store.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthSessionCleanupRequiredError);
    expect(error).toMatchObject({
      name: 'AuthSessionCleanupRequiredError',
      message: 'Authentication session cleanup is required',
    });
    expect(error).not.toBe(cleanupFailure);
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('raw-secret-sentinel');
    expect(String(error)).not.toContain('native-secret-sentinel');
  });
});

function createClient(): jest.Mocked<SecureStoreClient> {
  return {
    isAvailableAsync: jest.fn(async () => true),
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => undefined),
    deleteItemAsync: jest.fn(async () => undefined),
  };
}

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
