import { AuthSessionCleanupRequiredError, type AuthSessionStore } from '../application/interfaces';
import type { AuthSession } from '../domain/authSession';
import { decodeAuthSessionRecord, encodeAuthSessionRecord } from './authSessionRecord';

// 固定键名隔离记录版本，禁止把账号或 Token 拼进平台存储键。
const AUTH_SESSION_KEY = 'timeflow.auth.session.v1';
const SECURE_STORE_UNAVAILABLE_MESSAGE = 'Secure authentication session storage is unavailable';

/** 注入原生安全存储所需的最小能力，测试无需复制或模拟 Expo 模块。 */
export interface SecureStoreClient {
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Native 会话存储适配器；只持久化 codec 认可的认证记录，不泄露底层错误细节。 */
export class SecureAuthSessionStore implements AuthSessionStore {
  constructor(
    /** 客户端由组装边界注入，使平台 SDK 不渗透到领域与应用层。 */
    private readonly client: SecureStoreClient,
    /** 注入时钟确保过期判断可重复测试。 */
    private readonly now: () => number,
  ) {}

  async read(): Promise<AuthSession | undefined> {
    await this.ensureAvailable();
    const rawRecord = await this.client.getItemAsync(AUTH_SESSION_KEY);
    if (rawRecord === null) {
      return undefined;
    }

    const session = decodeAuthSessionRecord(rawRecord, this.now());
    if (session) {
      return session;
    }

    // 无效、未知版本和过期记录都必须清除；清理失败只暴露应用层的脱敏控制流错误。
    try {
      await this.client.deleteItemAsync(AUTH_SESSION_KEY);
    } catch {
      throw new AuthSessionCleanupRequiredError();
    }
    return undefined;
  }

  async write(session: AuthSession): Promise<void> {
    await this.ensureAvailable();
    const record = encodeAuthSessionRecord(session);
    await this.client.setItemAsync(AUTH_SESSION_KEY, record);
  }

  async clear(): Promise<void> {
    await this.ensureAvailable();
    await this.client.deleteItemAsync(AUTH_SESSION_KEY);
  }

  private async ensureAvailable(): Promise<void> {
    if (!(await this.client.isAvailableAsync())) {
      throw new Error(SECURE_STORE_UNAVAILABLE_MESSAGE);
    }
  }
}
