import { describe, expect, it } from '@jest/globals';

import {
  decodeAuthSessionRecord,
  encodeAuthSessionRecord,
} from '../../../../../src/features/auth/data/authSessionRecord';
import { AuthSessionCleanupRequiredError } from '../../../../../src/features/auth/application/interfaces';

const now = 1_000_000;
const session = {
  accountId: 'acc_001',
  accessToken: 'opaque-token-value',
  expiresAt: now + 30_001,
  username: 'timeflow_user',
};

describe('auth session record codec', () => {
  it('provides a fixed redacted cleanup error without a cause', () => {
    const error = new AuthSessionCleanupRequiredError();

    expect(error).toMatchObject({
      name: 'AuthSessionCleanupRequiredError',
      message: 'Authentication session cleanup is required',
    });
    expect(error.cause).toBeUndefined();
  });

  it('round trips a valid session using the fixed versioned record shape', () => {
    expect(decodeAuthSessionRecord(encodeAuthSessionRecord(session), now)).toEqual(session);
  });

  it('preserves opaque token text verbatim', () => {
    const opaqueToken = '  opaque token: /+=?  ';
    const record = encodeAuthSessionRecord({ ...session, accessToken: opaqueToken });

    expect(record).toBe(
      JSON.stringify({ version: 2, session: { ...session, accessToken: opaqueToken } }),
    );
    expect(decodeAuthSessionRecord(record, now)?.accessToken).toBe(opaqueToken);
  });

  it('keeps only canonical session fields when encoding and decoding', () => {
    const sensitiveSentinel = 'extra-sensitive-sentinel';
    const sessionWithUnexpectedFields = {
      ...session,
      unexpectedSensitiveField: sensitiveSentinel,
    };

    const record = encodeAuthSessionRecord(sessionWithUnexpectedFields);
    const decoded = decodeAuthSessionRecord(
      JSON.stringify({ version: 2, session: sessionWithUnexpectedFields }),
      now,
    );

    expect(JSON.parse(record)).toEqual({ version: 2, session });
    expect(record).not.toContain(sensitiveSentinel);
    expect(decoded).toEqual(session);
  });

  it.each([
    ['invalid JSON', '{'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a v1 record without username migration', JSON.stringify({ version: 1, session })],
    ['an unknown version', JSON.stringify({ version: 3, session })],
    ['a missing session', JSON.stringify({ version: 2 })],
    [
      'a whitespace-only token',
      JSON.stringify({ version: 2, session: { ...session, accessToken: '   ' } }),
    ],
    [
      'an infinite expiry',
      JSON.stringify({ version: 2, session: { ...session, expiresAt: Infinity } }),
    ],
    [
      'a missing username',
      JSON.stringify({ version: 2, session: { ...session, username: undefined } }),
    ],
    [
      'a whitespace-only username',
      JSON.stringify({ version: 2, session: { ...session, username: '   ' } }),
    ],
  ])('returns undefined for %s', (_description, record) => {
    expect(decodeAuthSessionRecord(record, now)).toBeUndefined();
  });

  it('treats the expiry-skew boundary as invalid while accepting the next millisecond', () => {
    expect(
      decodeAuthSessionRecord(
        JSON.stringify({ version: 2, session: { ...session, expiresAt: now + 30_000 } }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAuthSessionRecord(
        JSON.stringify({ version: 2, session: { ...session, expiresAt: now + 30_001 } }),
        now,
      ),
    ).toEqual({ ...session, expiresAt: now + 30_001 });
  });

  it('rejects records with version or session inherited from Object.prototype', () => {
    const versionDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'version');
    const sessionDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'session');

    try {
      // eslint-disable-next-line no-extend-native -- 受控原型污染回归测试；finally 会恢复并隔离全局状态。
      Object.defineProperties(Object.prototype, {
        version: { configurable: true, value: 2 },
        session: { configurable: true, value: session },
      });

      expect(decodeAuthSessionRecord('{}', now)).toBeUndefined();
      expect(decodeAuthSessionRecord(JSON.stringify({ version: 2 }), now)).toBeUndefined();
      expect(decodeAuthSessionRecord(JSON.stringify({ session }), now)).toBeUndefined();
    } finally {
      restoreObjectPrototypeProperty('version', versionDescriptor);
      restoreObjectPrototypeProperty('session', sessionDescriptor);
    }
  });

  it('throws a fixed redacted error for an invalid session without exposing its token', () => {
    const rawToken = 'secret-token-must-not-appear';

    expect(() =>
      encodeAuthSessionRecord({
        accountId: 'acc_001',
        accessToken: rawToken,
        expiresAt: Infinity,
        username: 'timeflow_user',
      }),
    ).toThrow('Invalid authentication session record');
    expect(() =>
      encodeAuthSessionRecord({
        accountId: 'acc_001',
        accessToken: rawToken,
        expiresAt: Infinity,
        username: 'timeflow_user',
      }),
    ).not.toThrow(rawToken);
  });
});

function restoreObjectPrototypeProperty(
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    // eslint-disable-next-line no-extend-native -- 恢复受控原型污染；try/finally 保证测试隔离。
    Object.defineProperty(Object.prototype, property, descriptor);
    return;
  }

  Reflect.deleteProperty(Object.prototype, property);
}
