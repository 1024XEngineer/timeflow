import { isObviouslyExpired, type AuthState } from '../domain';
import type { AuthInvalidationReason } from './authErrors';

/** 协调器通过此端口读取会话并驱动唯一的控制器失效入口。 */
export interface AuthInvalidationController {
  getAccessToken(): string | undefined;
  getState(): AuthState;
  invalidate(reason: AuthInvalidationReason): Promise<void>;
}

/** Token 只向基础设施提供；多个失效来源复用同一清理工作。 */
export class AuthInvalidationCoordinator {
  private invalidation: Promise<void> | undefined;

  constructor(
    private readonly options: {
      readonly controller: AuthInvalidationController;
      readonly now: () => number;
    },
  ) {}

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
      const invalidation = this.options.controller.invalidate(reason);
      this.invalidation = invalidation;
      void invalidation.then(
        () => this.release(invalidation),
        () => this.release(invalidation),
      );
    }
    return this.invalidation;
  }

  private release(invalidation: Promise<void>): void {
    if (this.invalidation === invalidation) {
      this.invalidation = undefined;
    }
  }
}
