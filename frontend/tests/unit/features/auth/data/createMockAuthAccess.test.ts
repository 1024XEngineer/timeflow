import { describe, expect, it } from '@jest/globals';

import {
  createMockAuthAccess,
  MOCK_PREVIEW_ACCOUNT_ID,
  MOCK_PREVIEW_ACCESS_TOKEN,
} from '../../../../../src/features/auth/data/createMockAuthAccess';

describe('createMockAuthAccess', () => {
  it('returns the preview session without calling a network client', async () => {
    const authAccess = createMockAuthAccess();
    await expect(authAccess({ password: 'anything1', username: 'reviewer' })).resolves.toEqual({
      account_id: MOCK_PREVIEW_ACCOUNT_ID,
      access_token: MOCK_PREVIEW_ACCESS_TOKEN,
      expires_in: 60 * 60 * 24 * 7,
    });
  });
});
