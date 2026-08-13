import type { AuthSessionStore } from './interfaces';
import {
  NOOP_AUTH_DIAGNOSTICS,
  recordAuthCleanupFailure,
  type AuthDiagnostics,
} from './AuthDiagnostics';

const RETRY_DELAY_MS = 1_000;

/** 删除失败后在后台重试；代次隔离旧清理，防止其误删新会话。 */
export class AuthSessionDeletionRetrier {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly clearings = new Set<Promise<void>>();

  constructor(
    private readonly store: AuthSessionStore,
    private readonly diagnostics: AuthDiagnostics = NOOP_AUTH_DIAGNOSTICS,
  ) {}

  async clearOrRetry(): Promise<void> {
    const generation = ++this.generation;
    this.clearScheduledRetry();
    await this.clear(generation);
  }

  async cancel(): Promise<void> {
    ++this.generation;
    this.clearScheduledRetry();
    await Promise.allSettled(this.clearings);
  }

  private async clear(generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }

    let clearing: Promise<void>;
    try {
      clearing = this.store.clear();
    } catch {
      this.handleClearFailure(generation);
      return;
    }
    this.clearings.add(clearing);
    try {
      await clearing;
    } catch {
      this.handleClearFailure(generation);
    } finally {
      this.clearings.delete(clearing);
    }
  }

  private handleClearFailure(generation: number): void {
    recordAuthCleanupFailure(this.diagnostics, 'session-store');
    if (generation === this.generation) {
      this.scheduleRetry(generation);
    }
  }

  private scheduleRetry(generation: number): void {
    this.clearScheduledRetry();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.clear(generation);
    }, RETRY_DELAY_MS);
  }

  private clearScheduledRetry(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
