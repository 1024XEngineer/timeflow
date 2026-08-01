import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

const DEVICE_ID_KEY = 'timeflow.device_id';

export type DeviceIdStore = {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
};

type ExpoFileSystemLike = {
  documentDirectory: string | null;
  getInfoAsync: (path: string, options: Record<string, never>) => Promise<{ exists: boolean }>;
  readAsStringAsync: (path: string, options: Record<string, never>) => Promise<string>;
  writeAsStringAsync: (
    path: string,
    contents: string,
    options: Record<string, never>,
  ) => Promise<void>;
};

/**
 * Native storage is deliberately a hard dependency at runtime.  Falling back
 * to an in-process map makes the device identity change on every cold start,
 * which is worse than refusing to establish a session.
 */
export class DeviceIdPersistenceUnavailableError extends Error {
  constructor(message = '原生设备存储不可用，无法持久化 device_id') {
    super(message);
    this.name = 'DeviceIdPersistenceUnavailableError';
  }
}

function webStore(): DeviceIdStore {
  return {
    async get() {
      if (typeof localStorage === 'undefined') {
        throw new DeviceIdPersistenceUnavailableError('浏览器 localStorage 不可用');
      }
      return localStorage.getItem(DEVICE_ID_KEY);
    },
    async set(value) {
      if (typeof localStorage === 'undefined') {
        throw new DeviceIdPersistenceUnavailableError('浏览器 localStorage 不可用');
      }
      localStorage.setItem(DEVICE_ID_KEY, value);
    },
  };
}

/** Test/host adapter. Production code must inject a persistent implementation. */
export function memoryStore(seed: Map<string, string> = new Map()): DeviceIdStore {
  return {
    async get() {
      return seed.get(DEVICE_ID_KEY) ?? null;
    },
    async set(value) {
      seed.set(DEVICE_ID_KEY, value);
    },
  };
}

let nativeFileStore: DeviceIdStore | null = null;
let nativeFileStorePromise: Promise<DeviceIdStore> | null = null;

function loadExpoFileSystem(): ExpoFileSystemLike | null {
  // Expo Go and a custom Expo runtime expose the legacy module under this
  // name.  The lookup is static and Metro-visible; there is no hidden import
  // or optional JS package that can silently disappear from a release bundle.
  return requireOptionalNativeModule<ExpoFileSystemLike>('ExponentFileSystem');
}

function createNativeFileStore(FileSystem = loadExpoFileSystem()): DeviceIdStore {
  const base = FileSystem?.documentDirectory;
  if (
    !FileSystem ||
    !base ||
    typeof FileSystem.getInfoAsync !== 'function' ||
    typeof FileSystem.readAsStringAsync !== 'function' ||
    typeof FileSystem.writeAsStringAsync !== 'function'
  ) {
    throw new DeviceIdPersistenceUnavailableError(
      'ExpoFileSystem 原生模块未链接；请在构建中声明 expo-file-system 或注入 DeviceIdStore',
    );
  }
  const path = `${base}.timeflow-device-id`;
  return {
    async get() {
      let info: { exists: boolean };
      try {
        info = await FileSystem.getInfoAsync(path, {});
      } catch (error) {
        throw new DeviceIdPersistenceUnavailableError(
          `读取 device_id 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!info.exists) return null;
      try {
        const value = await FileSystem.readAsStringAsync(path, {});
        return value.trim() || null;
      } catch (error) {
        throw new DeviceIdPersistenceUnavailableError(
          `读取 device_id 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async set(value) {
      try {
        await FileSystem.writeAsStringAsync(path, value, {});
      } catch (error) {
        throw new DeviceIdPersistenceUnavailableError(
          `写入 device_id 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export async function createDeviceIdStore(): Promise<DeviceIdStore> {
  if (Platform.OS === 'web') {
    return webStore();
  }
  if (!nativeFileStore) {
    nativeFileStorePromise ??= Promise.resolve()
      .then(() => createNativeFileStore())
      .catch((error) => {
        // A transient host/module setup failure should not poison all later
        // attempts during the same app lifetime.
        nativeFileStorePromise = null;
        throw error;
      });
    nativeFileStore = await nativeFileStorePromise;
  }
  return nativeFileStore;
}

export async function getOrCreateDeviceId(store?: DeviceIdStore): Promise<string> {
  const backend = store ?? (await createDeviceIdStore());
  const existing = await backend.get();
  if (existing) return existing;
  const next = `device_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await backend.set(next);
  // Read back once so a best-effort native implementation cannot report a
  // successful write while losing the value (for example, a denied file URI).
  const persisted = await backend.get();
  if (persisted !== next) {
    throw new DeviceIdPersistenceUnavailableError('device_id 写入后校验失败');
  }
  return next;
}
