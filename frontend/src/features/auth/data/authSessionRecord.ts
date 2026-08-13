import { isAuthSession, isObviouslyExpired, type AuthSession } from '../domain/authSession';

const AUTH_SESSION_RECORD_VERSION = 1;
const INVALID_AUTH_SESSION_RECORD_MESSAGE = 'Invalid authentication session record';

interface AuthSessionRecord {
  readonly version: typeof AUTH_SESSION_RECORD_VERSION;
  readonly session: AuthSession;
}

/** 将领域校验通过的会话封装为版本化记录，不改写或解析 opaque Token。 */
export function encodeAuthSessionRecord(session: AuthSession): string {
  if (!isAuthSession(session)) {
    throw new Error(INVALID_AUTH_SESSION_RECORD_MESSAGE);
  }

  const record: AuthSessionRecord = {
    version: AUTH_SESSION_RECORD_VERSION,
    session: copyAuthSession(session),
  };
  return JSON.stringify(record);
}

/**
 * 仅还原可安全继续使用的版本化记录；格式或过期问题统一降级为 undefined，避免泄露记录内容。
 */
export function decodeAuthSessionRecord(record: string, now: number): AuthSession | undefined {
  const parsedRecord = parseRecord(record);
  if (
    !parsedRecord ||
    !hasOwnProperty(parsedRecord, 'version') ||
    !hasOwnProperty(parsedRecord, 'session') ||
    parsedRecord.version !== AUTH_SESSION_RECORD_VERSION ||
    !isAuthSession(parsedRecord.session) ||
    isObviouslyExpired(parsedRecord.session, now)
  ) {
    return undefined;
  }

  return copyAuthSession(parsedRecord.session);
}

function copyAuthSession(session: AuthSession): AuthSession {
  return {
    accountId: session.accountId,
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
  };
}

function parseRecord(record: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(record) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnProperty(record: Record<string, unknown>, property: string): boolean {
  // 不能信任原型链字段，避免伪造版本或会话绕过记录结构校验。
  return Object.prototype.hasOwnProperty.call(record, property);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
