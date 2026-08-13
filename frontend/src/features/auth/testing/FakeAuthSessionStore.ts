import type { AuthSessionStore } from '../application/interfaces';
import type { AuthSession } from '../domain';

/** 认证应用层测试共用的可控存储，集中表达读写和清理故障。 */
export class FakeAuthSessionStore implements AuthSessionStore {
  session: AuthSession | undefined;
  readError: unknown;
  writeError: unknown;
  clearError: unknown;
  beforeRead: (() => Promise<void>) | undefined;
  beforeClear: (() => Promise<void>) | undefined;

  async read(): Promise<AuthSession | undefined> {
    await this.beforeRead?.();
    if (this.readError) {
      throw this.readError;
    }
    return this.session;
  }

  async write(session: AuthSession): Promise<void> {
    if (this.writeError) {
      throw this.writeError;
    }
    this.session = session;
  }

  async clear(): Promise<void> {
    await this.beforeClear?.();
    if (this.clearError) {
      throw this.clearError;
    }
    this.session = undefined;
  }
}
