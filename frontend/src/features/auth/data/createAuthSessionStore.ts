import * as ExpoSecureStore from 'expo-secure-store';

import type { AuthSessionStore } from '../application/interfaces';
import { MemoryAuthSessionStore } from './MemoryAuthSessionStore';
import { SecureAuthSessionStore, type SecureStoreClient } from './SecureAuthSessionStore';

const UNSUPPORTED_PLATFORM_MESSAGE = 'Unsupported authentication session storage platform';

/** 工厂依赖允许组装层显式覆盖平台、原生客户端和时钟。 */
export interface CreateAuthSessionStoreOptions {
  readonly platform?: string;
  readonly secureStoreClient?: SecureStoreClient;
  readonly now?: () => number;
}

/** 集中选择会话存储，未知平台直接失败，避免敏感会话被静默降级到内存。 */
export function createAuthSessionStore(
  options: CreateAuthSessionStoreOptions = {},
): AuthSessionStore {
  const platform = Object.prototype.hasOwnProperty.call(options, 'platform')
    ? options.platform
    : process.env.EXPO_OS;

  if (platform === 'web') {
    return new MemoryAuthSessionStore();
  }
  if (platform === 'android' || platform === 'ios') {
    return new SecureAuthSessionStore(
      options.secureStoreClient ?? ExpoSecureStore,
      options.now ?? Date.now,
    );
  }
  throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
}
