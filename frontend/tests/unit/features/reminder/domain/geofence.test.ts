import { describe, expect, it } from '@jest/globals';

import { resolveGuardPollIntervalMs } from '../../../../../src/features/reminder/domain/geofence';

describe('resolveGuardPollIntervalMs', () => {
  it('returns the densest interval at or inside the near threshold', () => {
    expect(resolveGuardPollIntervalMs(0)).toBe(15_000);
    expect(resolveGuardPollIntervalMs(50)).toBe(15_000);
  });

  it('returns the sparsest interval at or beyond the far threshold', () => {
    expect(resolveGuardPollIntervalMs(2_000)).toBe(300_000);
    expect(resolveGuardPollIntervalMs(10_000)).toBe(300_000);
  });

  it('interpolates linearly between the two thresholds', () => {
    // 中点 (50+2000)/2 = 1025m -> 中间值
    expect(resolveGuardPollIntervalMs(1_025)).toBe(157_500);
  });

  it('falls back to the sparsest interval for a non-finite distance (nothing being watched)', () => {
    expect(resolveGuardPollIntervalMs(Number.POSITIVE_INFINITY)).toBe(300_000);
    expect(resolveGuardPollIntervalMs(NaN)).toBe(300_000);
  });
});
