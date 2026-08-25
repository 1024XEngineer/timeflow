import { describe, expect, it } from '@jest/globals';

import { boundManufacturer, boundOs, boundPermissions } from '../../../../src/shared/observability';

describe('device telemetry tags', () => {
  it('maps unknown or null manufacturers to other', () => {
    expect(boundManufacturer('xiaomi')).toBe('xiaomi');
    expect(boundManufacturer('Huawei')).toBe('other');
    expect(boundManufacturer(null)).toBe('other');
    expect(boundManufacturer('samsung')).toBe('other');
  });

  it('maps platform strings to a closed os enum', () => {
    expect(boundOs('android')).toBe('android');
    expect(boundOs('ios')).toBe('ios');
    expect(boundOs('web')).toBe('web');
    expect(boundOs('macos')).toBe('other');
    expect(boundOs(undefined)).toBe('other');
  });

  it('keeps only the closed permission names, in stable order', () => {
    expect(boundPermissions(['overlay', 'unknown', 'exact_alarm'])).toEqual([
      'exact_alarm',
      'overlay',
    ]);
  });
});
