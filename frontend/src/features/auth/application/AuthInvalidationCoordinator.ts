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
    const accountStateCleaners = this.options.accountStateCleaners;
    if (accountStateCleaners) {
      await this.runStage('account-state', () => accountStateCleaners.clearAll());
    }
    await this.runStage('session-store', () => this.options.controller.invalidate(reason));
  }

  private async runStage(
    component: AuthDiagnosticComponent,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      recordAuthCleanupFailure(
        this.options.diagnostics ?? NOOP_AUTH_DIAGNOSTICS,
        component,
      );
    }
  }

  private release(invalidation: Promise<void>): void {
    if (this.invalidation === invalidation) {
      this.invalidation = undefined;
    }
  }
}
