import { describe, expect, it } from '@jest/globals';

import { resolveNextPollIntervalMs } from '../../../../src/infrastructure/location/reminderGuardTask';

describe('resolveNextPollIntervalMs', () => {
  it('falls back to the sparsest interval when there is no sample or no targets', () => {
    expect(resolveNextPollIntervalMs(null, [{ latitude: 31.23, longitude: 121.47 }])).toBe(300_000);
    expect(resolveNextPollIntervalMs({ latitude: 31.23, longitude: 121.47 }, [])).toBe(300_000);
  });

  it('picks the nearest target among several to decide the interval', () => {
    const sample = { latitude: 31.2304, longitude: 121.4737 };
    const near = { latitude: 31.2304, longitude: 121.4737 }; // ~0m away
    const far = { latitude: 31.32, longitude: 121.4737 }; // far away
    expect(resolveNextPollIntervalMs(sample, [far, near])).toBe(15_000);
  });
});
