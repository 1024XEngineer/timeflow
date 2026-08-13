import type { AuthSession } from '../../domain/authSession';

const AUTH_SESSION_CLEANUP_REQUIRED_MESSAGE = 'Authentication session cleanup is required';

/** 应用层的敏感会话存储端口；具体平台存储由 data 层注入，应用层不接触其实现。 */
export interface AuthSessionStore {
  read(): Promise<AuthSession | undefined>;
  write(session: AuthSession): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 无效记录无法清理时供应用层识别的控制流错误；始终只保留固定脱敏消息。
 */
export class AuthSessionCleanupRequiredError extends Error {
  constructor() {
    super(AUTH_SESSION_CLEANUP_REQUIRED_MESSAGE);
    this.name = 'AuthSessionCleanupRequiredError';
  }
}
