import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_GEOFENCE_RADIUS_METERS,
  resolveGuardPollIntervalMs,
} from '../../../../../src/features/reminder/domain/geofence';

describe('resolveGuardPollIntervalMs', () => {
  // 输入现在是"离围栏边界还有多远"，不是"离中心点多远"；最密档的门槛就是
  // 围栏半径本身（见 geofence.ts 里 GUARD_POLL_NEAR_METERS 的注释）。
  it('returns the densest interval at or inside the near threshold (the geofence radius itself)', () => {
    expect(resolveGuardPollIntervalMs(0)).toBe(15_000);
    expect(resolveGuardPollIntervalMs(DEFAULT_GEOFENCE_RADIUS_METERS)).toBe(15_000);
  });

  it('returns the sparsest interval at or beyond the far threshold', () => {
    expect(resolveGuardPollIntervalMs(2_000)).toBe(300_000);
    expect(resolveGuardPollIntervalMs(10_000)).toBe(300_000);
  });

  it('interpolates linearly between the two thresholds', () => {
    // 中点 (半径 + 2000) / 2 -> 中间值
    const midpoint = (DEFAULT_GEOFENCE_RADIUS_METERS + 2_000) / 2;
    expect(resolveGuardPollIntervalMs(midpoint)).toBe(157_500);
  });

  it('falls back to the sparsest interval for a non-finite distance (nothing being watched)', () => {
    expect(resolveGuardPollIntervalMs(Number.POSITIVE_INFINITY)).toBe(300_000);
    expect(resolveGuardPollIntervalMs(NaN)).toBe(300_000);
  });
});
