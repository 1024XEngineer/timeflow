import type { MapLocation } from '@/shared/types/geo';

export const BAIDU_MAP_AK = process.env.EXPO_PUBLIC_BAIDU_MAP_AK?.trim() ?? '';
export const BAIDU_COORDINATE_SYSTEM = 'bd09ll' as const;

export const SHANGHAI_CENTER: MapLocation = {
  address: '上海市 · 默认地图中心',
  latitude: 31.236305,
  longitude: 121.480237,
};

export function coordinateAddress(latitude: number, longitude: number) {
  return `百度地图选点 · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function createCoordinateLocation(latitude: number, longitude: number): MapLocation {
  return {
    address: coordinateAddress(latitude, longitude),
    latitude,
    longitude,
  };
}

export function readablePoiAddress(title: string, address?: string) {
  return address?.trim() ? `${title} · ${address.trim()}` : title;
}
