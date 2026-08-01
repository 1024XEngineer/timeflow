import { describe, expect, it } from '@jest/globals';

import { colors, spacing } from '@/shared/theme/index';

describe('theme tokens', () => {
  it('exposes the brand palette and spacing scale', () => {
    expect(colors.deep).toBe('#15352B');
    expect(colors.lime).toBe('#D7F36A');
    expect(spacing.md).toBe(16);
  });
});
