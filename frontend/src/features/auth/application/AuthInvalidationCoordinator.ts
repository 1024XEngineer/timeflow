import { isObviouslyExpired, type AuthState } from '../domain';
import type { AuthInvalidationReason } from './authErrors';
import {
  NOOP_AUTH_DIAGNOSTICS,
  recordAuthCleanupFailure,
  type AuthDiagnosticComponent,
  type AuthDiagnostics,
} from './AuthDiagnostics';

/** 协调器通过此端口读取会话并驱动唯一的控制器失效入口。 */
export interface AuthInvalidationController {
  getAccessToken(): string | undefined;
  getState(): AuthState;
  invalidate(reason: AuthInvalidationReason): Promise<void>;
}

export interface AccountStateCleanupPort {
  clearAll(): Promise<void>;
}

export interface AuthSocketClosePort {
  close(): void;
}

export interface AuthInvalidationCoordinatorOptions {
  readonly accountStateCleaners?: AccountStateCleanupPort;
  readonly controller: AuthInvalidationController;
  readonly diagnostics?: AuthDiagnostics;
  readonly now: () => number;
  readonly socket?: AuthSocketClosePort;
}

/** 账号内存清理（提醒引擎 / 定位 stop）卡住时，不能挡住会话失效和登录页。 */
export const ACCOUNT_STATE_CLEANUP_TIMEOUT_MS = 2_000;

/** Token 只向基础设施提供；多个失效来源复用同一清理工作。 */
export class AuthInvalidationCoordinator {
  private invalidation: Promise<void> | undefined;

  constructor(private readonly options: AuthInvalidationCoordinatorOptions) {}

  isInvalidating(): boolean {
    return this.invalidation !== undefined;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.isInvalidating()) {
      return undefined;
    }

    const state = this.options.controller.getState();
    if (state.status === 'authenticated' && isObviouslyExpired(state.session, this.options.now())) {
      await this.invalidate('expired');
      return undefined;
    }

    return this.options.controller.getAccessToken();
  }

  invalidate(reason: AuthInvalidationReason): Promise<void> {
    if (!this.invalidation) {
      const invalidation = this.runInvalidation(reason);
      this.invalidation = invalidation;
      void invalidation.then(
        () => this.release(invalidation),
        () => this.release(invalidation),
      );
    }
    return this.invalidation;
  }

  private async runInvalidation(reason: AuthInvalidationReason): Promise<void> {
    const socket = this.options.socket;
    if (socket) {
      await this.runStage('websocket', () => socket.close());
    }
    // 先清会话再拆账号内存。首页登出 await 的就是这一条 Promise：提醒/定位
    // native stop 在真机上可能永远不回来，排在会话前面就会一直转圈、进不了登录页。
    // HTTP 401 也会 await 同一条 Promise；如果它还卡在 reminder.stop 等这条
    // 请求自己，就会死锁。
    await this.runStage('session-store', () => this.options.controller.invalidate(reason));
    const accountStateCleaners = this.options.accountStateCleaners;
    if (accountStateCleaners) {
      const cleanup = Promise.resolve(accountStateCleaners.clearAll()).then(
        () => undefined,
        () => {
          recordAuthCleanupFailure(
            this.options.diagnostics ?? NOOP_AUTH_DIAGNOSTICS,
            'account-state',
          );
        },
      );
      await raceWithTimeout(cleanup, ACCOUNT_STATE_CLEANUP_TIMEOUT_MS);
    }
  }

  private async runStage(
    component: AuthDiagnosticComponent,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      recordAuthCleanupFailure(this.options.diagnostics ?? NOOP_AUTH_DIAGNOSTICS, component);
    }
  }

  private release(invalidation: Promise<void>): void {
    if (this.invalidation === invalidation) {
      this.invalidation = undefined;
    }
  }
}

function raceWithTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
