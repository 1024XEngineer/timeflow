/** WebSocket 会话握手的唯一线上契约，避免基础设施自行猜测服务端响应。 */
export interface SessionHello {
  readonly type: 'session.hello';
  readonly request_id: string;
  readonly payload: {
    readonly access_token: string;
    readonly device_id: string;
  };
}

export interface SessionReady {
  readonly type: 'session.ready';
  readonly request_id: string;
  readonly ok: true;
  readonly payload: {
    readonly session_id: string;
    readonly server_time: string;
  };
}

export type SessionErrorCode = 'UNAUTHENTICATED' | 'MALFORMED_MESSAGE';

export interface SessionError {
  readonly type: 'session.error';
  readonly request_id: string;
  readonly ok: false;
  readonly error: {
    readonly code: SessionErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type SessionServerMessage = SessionReady | SessionError;

/** 统一创建首帧，Token 保持不透明且原样传输。 */
export function createSessionHello(options: {
  readonly accessToken: string;
  readonly deviceId: string;
  readonly requestId: string;
}): SessionHello {
  return {
    payload: { access_token: options.accessToken, device_id: options.deviceId },
    request_id: options.requestId,
    type: 'session.hello',
  };
}

/** 只接受会话握手的两类服务端文本帧，拒绝原型链字段和宽松日期。 */
export function parseSessionServerMessage(value: unknown): SessionServerMessage | undefined {
  if (!isRecord(value) || !hasOwn(value, 'type') || !hasOwn(value, 'ok')) {
    return undefined;
  }
  const requestId = readNonBlankString(value, 'request_id');
  if (!requestId) {
    return undefined;
  }

  if (
    value.type === 'session.ready' &&
    value.ok === true &&
    hasOwn(value, 'payload') &&
    isRecord(value.payload)
  ) {
    const payload = value.payload;
    const sessionId = readNonBlankString(payload, 'session_id');
    const serverTime = readRfc3339Timezone(payload, 'server_time');
    if (sessionId && serverTime) {
      return {
        ok: true,
        payload: { server_time: serverTime, session_id: sessionId },
        request_id: requestId,
        type: 'session.ready',
      };
    }
  }

  if (
    value.type === 'session.error' &&
    value.ok === false &&
    hasOwn(value, 'error') &&
    isRecord(value.error)
  ) {
    const error = value.error;
    const code = readSessionErrorCode(error, 'code');
    const message = readNonBlankString(error, 'message');
    const retryable = readBoolean(error, 'retryable');
    if (code && message && retryable !== undefined) {
      return {
        error: { code, message, retryable },
        ok: false,
        request_id: requestId,
        type: 'session.error',
      };
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function readNonBlankString(record: Record<string, unknown>, property: string): string | undefined {
  const value = record[property];
  return hasOwn(record, property) && typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readBoolean(record: Record<string, unknown>, property: string): boolean | undefined {
  const value = record[property];
  return hasOwn(record, property) && typeof value === 'boolean' ? value : undefined;
}

function readSessionErrorCode(
  record: Record<string, unknown>,
  property: string,
): SessionErrorCode | undefined {
  const value = record[property];
  return hasOwn(record, property) && (value === 'UNAUTHENTICATED' || value === 'MALFORMED_MESSAGE')
    ? value
    : undefined;
}

function readRfc3339Timezone(
  record: Record<string, unknown>,
  property: string,
): string | undefined {
  const value = readNonBlankString(record, property);
  if (!value) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}
