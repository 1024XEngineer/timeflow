import { afterEach, describe, expect, it } from '@jest/globals';

import { MemoryAuthSessionStore } from '../../../../../src/features/auth/data/MemoryAuthSessionStore';

const session = {
  accountId: 'acc_001',
  accessToken: 'opaque-token-value',
  expiresAt: 1_030_001,
};

const persistentStorageGlobals = ['localStorage', 'sessionStorage', 'indexedDB'] as const;
const originalDescriptors = new Map(
  persistentStorageGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
  for (const name of persistentStorageGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

describe('MemoryAuthSessionStore', () => {
  it('starts empty, returns its written session, and clears it', async () => {
    const store = new MemoryAuthSessionStore();

    await expect(store.read()).resolves.toBeUndefined();
    await expect(store.write(session)).resolves.toBeUndefined();
    await expect(store.read()).resolves.toEqual(session);
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('keeps sessions isolated to each store instance', async () => {
    const firstStore = new MemoryAuthSessionStore();
    const secondStore = new MemoryAuthSessionStore();

    await firstStore.write(session);

    await expect(firstStore.read()).resolves.toEqual(session);
    await expect(secondStore.read()).resolves.toBeUndefined();
  });

  it('never accesses browser persistent storage globals', async () => {
    for (const name of persistentStorageGlobals) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => {
          throw new Error(`${name} must not be accessed`);
        },
      });
    }
    const store = new MemoryAuthSessionStore();

    await store.write(session);
    await expect(store.read()).resolves.toEqual(session);
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
