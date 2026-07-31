import { describe, expect, it } from '@jest/globals';

import {
  BAIDU_COORDINATE_SYSTEM,
  SHANGHAI_CENTER,
  coordinateAddress,
  createCoordinateLocation,
  readablePoiAddress,
} from '@/features/schedule/location/MapPicker/baidu/services';

describe('map picker services', () => {
  it('exposes the Baidu coordinate system and Shanghai default', () => {
    expect(BAIDU_COORDINATE_SYSTEM).toBe('bd09ll');
    expect(SHANGHAI_CENTER.latitude).toBeCloseTo(31.236305);
    expect(SHANGHAI_CENTER.longitude).toBeCloseTo(121.480237);
  });

  it('formats a coordinate fallback address', () => {
    expect(coordinateAddress(31.2, 121.5)).toBe('百度地图选点 · 31.20000, 121.50000');
  });

  it('builds a MapLocation from coordinates', () => {
    expect(createCoordinateLocation(31.2, 121.5)).toEqual({
      address: '百度地图选点 · 31.20000, 121.50000',
      latitude: 31.2,
      longitude: 121.5,
    });
  });

  it('joins POI title with address when present', () => {
    expect(readablePoiAddress('外滩', '中山东一路')).toBe('外滩 · 中山东一路');
    expect(readablePoiAddress('外滩', '  ')).toBe('外滩');
    expect(readablePoiAddress('外滩')).toBe('外滩');
  });
});
