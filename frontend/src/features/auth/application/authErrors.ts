const PERSISTENCE_ERROR_MESSAGE = 'Authentication session could not be saved';

/** 会话写入失败的固定脱敏错误，避免底层存储信息泄露到界面。 */
export class AuthSessionPersistenceError extends Error {
  constructor() {
    super(PERSISTENCE_ERROR_MESSAGE);
    this.name = 'AuthSessionPersistenceError';
  }
}

/** 基础失效来源由调用方归类，控制器只负责安全退出当前会话。 */
export type AuthInvalidationReason = 'expired' | 'revoked';

/** 非 Web 预览环境禁止跳过线上认证。 */
export class LocalPreviewAuthDisabledError extends Error {
  constructor() {
    super('Local preview authentication is disabled');
    this.name = 'LocalPreviewAuthDisabledError';
  }
}
