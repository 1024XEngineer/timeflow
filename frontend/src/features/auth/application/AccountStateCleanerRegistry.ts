import {
  NOOP_AUTH_DIAGNOSTICS,
  recordAuthCleanupFailure,
  type AuthDiagnostics,
} from './AuthDiagnostics';

export type AccountStateCleanerKey = 'schedule-view' | 'reminder-runtime';
export type AccountStateCleaner = () => void | Promise<void>;

/** 重复 key 会掩盖一个账号状态来源，因此以固定错误立即拒绝。 */
export class AccountStateCleanerAlreadyRegisteredError extends Error {
  constructor() {
    super('Account state cleaner key is already registered');
    this.name = 'AccountStateCleanerAlreadyRegisteredError';
  }
}

/** 按注册顺序清理固定账号内存来源，单项失败不影响后续来源。 */
export class AccountStateCleanerRegistry {
  private readonly cleaners = new Map<AccountStateCleanerKey, AccountStateCleaner>();

  constructor(private readonly diagnostics: AuthDiagnostics = NOOP_AUTH_DIAGNOSTICS) {}

  register(key: AccountStateCleanerKey, cleaner: AccountStateCleaner): void {
    if (this.cleaners.has(key)) {
      throw new AccountStateCleanerAlreadyRegisteredError();
    }
    this.cleaners.set(key, cleaner);
  }

  async clearAll(): Promise<void> {
    for (const [key, cleaner] of this.cleaners) {
      try {
        await cleaner();
      } catch {
        recordAuthCleanupFailure(this.diagnostics, key);
      }
    }
  }
}
