import { afterEach, describe, expect, it } from '@jest/globals';

import { isMockMode } from '../../../src/app/previewMode';

describe('isMockMode', () => {
  const original = process.env.EXPO_PUBLIC_MOCK_MODE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_MOCK_MODE;
    } else {
      process.env.EXPO_PUBLIC_MOCK_MODE = original;
    }
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    [undefined, false],
  ])('reads EXPO_PUBLIC_MOCK_MODE=%s', (value, expected) => {
    if (value === undefined) {
      delete process.env.EXPO_PUBLIC_MOCK_MODE;
    } else {
      process.env.EXPO_PUBLIC_MOCK_MODE = value;
    }
    expect(isMockMode()).toBe(expected);
  });
});
