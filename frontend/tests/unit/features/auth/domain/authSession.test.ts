import { describe, expect, it } from '@jest/globals';

import type { AuthAccessResponse } from '../../../../../src/contracts/auth';
import {
  createAuthSession,
  isAuthSession,
  isObviouslyExpired,
  type AuthState,
  type AuthViewState,
} from '../../../../../src/features/auth/domain/authSession';

const response: AuthAccessResponse = {
  account_id: 'acc_001',
  access_token: '  opaque access token  ',
  expires_in: 3600,
};

describe('createAuthSession', () => {
  it('calculates its expiry from the fixed TTL', () => {
    expect(createAuthSession(response, 1_000_000)).toEqual({
      accountId: 'acc_001',
      accessToken: '  opaque access token  ',
      expiresAt: 4_600_000,
    });
  });

  it('preserves the opaque token verbatim', () => {
    expect(createAuthSession(response, 0).accessToken).toBe('  opaque access token  ');
  });

  it('throws a fixed redacted error for an invalid response', () => {
    const rawToken = 'secret-token-must-not-appear';

    expect(() =>
      createAuthSession({ account_id: 'acc_001', access_token: rawToken, expires_in: 3599 }, 0),
    ).toThrow('Invalid authentication access response');
    expect(() =>
      createAuthSession({ account_id: 'acc_001', access_token: rawToken, expires_in: 3599 }, 0),
    ).not.toThrow(rawToken);
  });
});

describe('isAuthSession', () => {
  it.each([
    [{ accountId: 'acc_001', accessToken: 'token', expiresAt: 1 }, true],
    [{ accountId: '', accessToken: 'token', expiresAt: 1 }, false],
    [{ accountId: '   ', accessToken: 'token', expiresAt: 1 }, false],
    [{ accountId: 'acc_001', accessToken: '', expiresAt: 1 }, false],
    [{ accountId: 'acc_001', accessToken: '   ', expiresAt: 1 }, false],
    [{ accountId: 'acc_001', accessToken: 'token', expiresAt: Infinity }, false],
    [Object.assign([] as unknown[], { accountId: 'acc_001', accessToken: 'token', expiresAt: 1 }), false],
  ])('validates session fields for %p', (session, expected) => {
    expect(isAuthSession(session)).toBe(expected);
  });
});

describe('isObviouslyExpired', () => {
  const session = { accountId: 'acc_001', accessToken: 'token', expiresAt: 130_000 };

  it('treats the 30-second boundary as expired', () => {
    expect(isObviouslyExpired(session, 100_000)).toBe(true);
  });

  it('keeps sessions beyond the 30-second boundary active', () => {
    expect(isObviouslyExpired({ ...session, expiresAt: 130_001 }, 100_000)).toBe(false);
  });
});

describe('auth state discriminated unions', () => {
  it('models state-specific session and account fields', () => {
    const states: AuthState[] = [
      { status: 'loading', initializationError: 'Session restoration failed' },
      { status: 'unauthenticated' },
      { status: 'authenticated', session: createAuthSession(response, 0) },
    ];
    const viewStates: AuthViewState[] = [
      { status: 'loading', initializationError: 'Session restoration failed' },
      { status: 'unauthenticated' },
      { status: 'authenticated', accountId: 'acc_001' },
    ];

    expect(states.map((state) => state.status)).toEqual([
      'loading',
      'unauthenticated',
      'authenticated',
    ]);
    expect(viewStates.map((state) => state.status)).toEqual([
      'loading',
      'unauthenticated',
      'authenticated',
    ]);
  });
});

function assertAuthViewStateBoundary(
  state: Extract<AuthViewState, { status: 'authenticated' }>,
): void {
  // @ts-expect-error 展示状态不得暴露访问令牌。
  void state.accessToken;
  // @ts-expect-error 展示状态不得暴露完整会话。
  void state.session;
}

void assertAuthViewStateBoundary;
