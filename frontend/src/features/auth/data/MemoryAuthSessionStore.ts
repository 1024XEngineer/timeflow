import type { AuthSessionStore } from '../application/interfaces';
import type { AuthSession } from '../domain/authSession';

/** Web 的进程内会话存储：仅当前实例有效，不使用任何浏览器持久化能力。 */
export class MemoryAuthSessionStore implements AuthSessionStore {
  private session: AuthSession | undefined;

  async read(): Promise<AuthSession | undefined> {
    return this.session;
  }

  async write(session: AuthSession): Promise<void> {
    this.session = session;
  }

  async clear(): Promise<void> {
    this.session = undefined;
  }
}
