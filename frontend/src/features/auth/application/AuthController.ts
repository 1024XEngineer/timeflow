import type { AuthAccess, AuthAccessRequest } from '../../../contracts/auth';
import {
  createAuthSession,
  isObviouslyExpired,
  type AuthState,
  type AuthViewState,
} from '../domain';
import { AuthSessionDeletionRetrier } from './AuthSessionDeletionRetrier';
import { AuthSessionPersistenceError, type AuthInvalidationReason } from './authErrors';
import { AuthSessionCleanupRequiredError, type AuthSessionStore } from './interfaces';

const INITIALIZATION_ERROR_MESSAGE = '无法恢复登录状态，请重试';

/** 控制器依赖均由 app 组合，避免应用层触及具体网络和安全存储。 */
export interface AuthControllerOptions {
  readonly authAccess: AuthAccess;
  readonly now: () => number;
  readonly store: AuthSessionStore;
}

/** 认证内部状态的唯一写入者；展示层只经由脱敏快照订阅。 */
export class AuthController {
  private state: AuthState = { status: 'loading' };
  private viewState: AuthViewState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private readonly retrier: AuthSessionDeletionRetrier;

  constructor(private readonly options: AuthControllerOptions) {
    this.retrier = new AuthSessionDeletionRetrier(options.store);
  }

  getState(): AuthState {
    return this.state;
  }

  getViewState(): AuthViewState {
    return this.viewState;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.restore();
  }

  async retryInitialization(): Promise<void> {
    this.publish({ status: 'loading' });
    await this.restore();
  }

  async authenticate(credentials: AuthAccessRequest): Promise<void> {
    const response = await this.options.authAccess(credentials);
    const session = createAuthSession(response, this.options.now());
    await this.retrier.cancel();
    try {
      await this.options.store.write(session);
    } catch {
      void this.retrier.clearOrRetry();
      throw new AuthSessionPersistenceError();
    }
    this.publish({ session, status: 'authenticated' });
  }

  async invalidate(_reason: AuthInvalidationReason): Promise<void> {
    await this.clearAndUnauthenticate();
  }

  async signOut(): Promise<void> {
    await this.clearAndUnauthenticate();
  }

  getAccessToken(): string | undefined {
    return this.state.status === 'authenticated' ? this.state.session.accessToken : undefined;
  }

  private async restore(): Promise<void> {
    try {
      const session = await this.options.store.read();
      if (!session) {
        this.publish({ status: 'unauthenticated' });
        return;
      }
      if (isObviouslyExpired(session, this.options.now())) {
        await this.clearAndUnauthenticate();
        return;
      }
      this.publish({ session, status: 'authenticated' });
    } catch (error) {
      if (error instanceof AuthSessionCleanupRequiredError) {
        await this.clearAndUnauthenticate();
        return;
      }
      this.publish({ initializationError: INITIALIZATION_ERROR_MESSAGE, status: 'loading' });
    }
  }

  private async clearAndUnauthenticate(): Promise<void> {
    await this.retrier.clearOrRetry();
    this.publish({ status: 'unauthenticated' });
  }

  private publish(state: AuthState): void {
    this.state = state;
    this.viewState = toViewState(state);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** 集中脱敏映射，确保任何展示订阅都无法获得会话或 Token。 */
function toViewState(state: AuthState): AuthViewState {
  if (state.status === 'authenticated') {
    return { accountId: state.session.accountId, status: 'authenticated' };
  }
  return state.status === 'loading'
    ? { initializationError: state.initializationError, status: 'loading' }
    : { status: 'unauthenticated' };
}
