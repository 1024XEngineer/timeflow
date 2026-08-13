import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { MemoryAuthSessionStore } from '../../../../../src/features/auth/data/MemoryAuthSessionStore';
import {
  SecureAuthSessionStore,
  type SecureStoreClient,
} from '../../../../../src/features/auth/data/SecureAuthSessionStore';
import { createAuthSessionStore } from '../../../../../src/features/auth/data/createAuthSessionStore';

const originalExpoOs = process.env.EXPO_OS;

afterEach(() => {
  if (originalExpoOs === undefined) {
    delete process.env.EXPO_OS;
  } else {
    process.env.EXPO_OS = originalExpoOs;
  }
});

describe('createAuthSessionStore', () => {
  it('returns a fresh isolated memory store for each web composition without calling the client', async () => {
    const client = createFailingClient();
    const firstStore = createAuthSessionStore({ platform: 'web', secureStoreClient: client });
    const secondStore = createAuthSessionStore({ platform: 'web', secureStoreClient: client });
    const session = {
      accountId: 'acc_001',
      accessToken: 'opaque-token-value',
      expiresAt: 1_030_001,
      username: 'timeflow_user',
    };

    expect(firstStore).toBeInstanceOf(MemoryAuthSessionStore);
    expect(secondStore).toBeInstanceOf(MemoryAuthSessionStore);
    expect(secondStore).not.toBe(firstStore);
    await firstStore.write(session);
    await expect(secondStore.read()).resolves.toBeUndefined();
    expectNoClientCalls(client);
  });

  it.each(['android', 'ios'] as const)('uses secure storage on %s', (platform) => {
    const client = createClient();

    const store = createAuthSessionStore({ platform, secureStoreClient: client });

    expect(store).toBeInstanceOf(SecureAuthSessionStore);
  });

  it('reads the default platform from EXPO_OS', () => {
    process.env.EXPO_OS = 'android';

    expect(createAuthSessionStore({ secureStoreClient: createClient() })).toBeInstanceOf(
      SecureAuthSessionStore,
    );
  });

  it('rejects an explicit undefined platform instead of reading EXPO_OS', () => {
    process.env.EXPO_OS = 'android';

    expect(() =>
      createAuthSessionStore({ platform: undefined, secureStoreClient: createClient() }),
    ).toThrow('Unsupported authentication session storage platform');
  });

  it('does not fall back to memory when native secure storage is unavailable', async () => {
    const client = createClient();
    client.isAvailableAsync.mockResolvedValue(false);
    const store = createAuthSessionStore({ platform: 'android', secureStoreClient: client });

    expect(store).toBeInstanceOf(SecureAuthSessionStore);
    await expect(store.read()).rejects.toThrow(
      'Secure authentication session storage is unavailable',
    );
  });

  it.each(['windows', undefined])(
    'rejects unsupported platform %s with a fixed error',
    (platform) => {
      delete process.env.EXPO_OS;

      expect(() => createAuthSessionStore({ platform, secureStoreClient: createClient() })).toThrow(
        'Unsupported authentication session storage platform',
      );
    },
  );
});

function createClient(): jest.Mocked<SecureStoreClient> {
  return {
    isAvailableAsync: jest.fn(async () => true),
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => undefined),
    deleteItemAsync: jest.fn(async () => undefined),
  };
}

function createFailingClient(): jest.Mocked<SecureStoreClient> {
  return {
    isAvailableAsync: jest.fn(async () => {
      throw new Error('web must not call secure storage');
    }),
    getItemAsync: jest.fn(async () => {
      throw new Error('web must not call secure storage');
    }),
    setItemAsync: jest.fn(async () => {
      throw new Error('web must not call secure storage');
    }),
    deleteItemAsync: jest.fn(async () => {
      throw new Error('web must not call secure storage');
    }),
  };
}

function expectNoClientCalls(client: jest.Mocked<SecureStoreClient>): void {
  expect(client.isAvailableAsync).not.toHaveBeenCalled();
  expect(client.getItemAsync).not.toHaveBeenCalled();
  expect(client.setItemAsync).not.toHaveBeenCalled();
  expect(client.deleteItemAsync).not.toHaveBeenCalled();
}
