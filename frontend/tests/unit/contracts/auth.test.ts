import { describe, expect, it } from '@jest/globals';

import {
  AUTH_ERROR_CODES,
  isAuthAccessErrorCode,
  parseAuthErrorEnvelope,
} from '../../../src/contracts/auth';

describe('parseAuthErrorEnvelope', () => {
  it.each([
    [
      'accepts the frozen nested envelope',
      { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' } },
      true,
    ],
    [
      'rejects the legacy top-level code',
      { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' },
      false,
    ],
    ['rejects an unknown code', { error: { code: 'AUTH_UNKNOWN', message: 'Unknown' } }, false],
    [
      'rejects inherited required fields',
      Object.create({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }),
      false,
    ],
    ['rejects incomplete nested values', { error: { code: 'AUTH_REQUIRED' } }, false],
    ['rejects arrays', [], false],
  ])('%s', (_name, body, accepted) => {
    expect(parseAuthErrorEnvelope(body) !== undefined).toBe(accepted);
  });

  it('only classifies token access failures as invalidation signals', () => {
    expect(Object.isFrozen(AUTH_ERROR_CODES)).toBe(true);
    expect(isAuthAccessErrorCode('AUTH_REQUIRED')).toBe(true);
    expect(isAuthAccessErrorCode('AUTH_INVALID_TOKEN')).toBe(true);
    expect(isAuthAccessErrorCode('AUTH_INVALID_CREDENTIALS')).toBe(false);
  });
});
