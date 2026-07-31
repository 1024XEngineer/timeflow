import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  createSavedLocation,
  matchSavedLocation,
  upsertSavedLocation,
} from '@/features/schedule/location/utils';
import type { SavedLocation } from '@/features/schedule/location/types';

const office: SavedLocation = {
  id: 'loc_office',
  address: '南京东路1号',
  latitude: 31.23,
  longitude: 121.48,
  name: '办公室',
};

describe('createSavedLocation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps an explicit id', () => {
    expect(
      createSavedLocation({ address: 'A', latitude: 1, longitude: 2, name: 'N' }, 'loc_fixed'),
    ).toEqual({
      address: 'A',
      latitude: 1,
      longitude: 2,
      name: 'N',
      id: 'loc_fixed',
    });
  });

  it('generates an id from Date.now when omitted', () => {
    jest.spyOn(Date, 'now').mockReturnValue(42);
    expect(createSavedLocation({ address: 'A', latitude: 1, longitude: 2 }).id).toBe('loc_42');
  });
});

describe('upsertSavedLocation', () => {
  it('appends a new location', () => {
    expect(upsertSavedLocation([], office)).toEqual([office]);
  });

  it('replaces an existing location with the same id', () => {
    const updated = { ...office, name: '总部' };
    expect(upsertSavedLocation([office], updated)).toEqual([updated]);
  });
});

describe('matchSavedLocation', () => {
  const locations = [office];

  it('matches by coordinates first', () => {
    expect(
      matchSavedLocation(locations, {
        latitude: 31.23,
        longitude: 121.48,
        location_name: '别的名字',
      }),
    ).toBe(office);
  });

  it('matches by name and address together', () => {
    expect(
      matchSavedLocation(locations, {
        location_name: '办公室',
        location_address: '南京东路1号',
      }),
    ).toBe(office);
  });

  it('matches by name alone', () => {
    expect(matchSavedLocation(locations, { location_name: '办公室' })).toBe(office);
  });

  it('matches by address alone', () => {
    expect(matchSavedLocation(locations, { location_address: '南京东路1号' })).toBe(office);
  });

  it('returns null when there is nothing to match on', () => {
    expect(matchSavedLocation(locations, {})).toBeNull();
    expect(matchSavedLocation(locations, { location_name: '  ', location_address: '' })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchSavedLocation(locations, { location_name: '咖啡馆' })).toBeNull();
  });
});
