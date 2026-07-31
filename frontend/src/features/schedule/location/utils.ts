import type { MapLocation, SavedLocation } from './types';

export function createSavedLocation(location: MapLocation, id?: string): SavedLocation {
  return {
    ...location,
    id: id ?? `loc_${Date.now()}`,
  };
}

export function upsertSavedLocation(
  locations: SavedLocation[],
  location: SavedLocation,
): SavedLocation[] {
  const index = locations.findIndex((item) => item.id === location.id);
  if (index < 0) {
    return [...locations, location];
  }
  const next = [...locations];
  next[index] = location;
  return next;
}

export function matchSavedLocation(
  locations: SavedLocation[],
  candidate: {
    latitude?: number | null;
    longitude?: number | null;
    location_name?: string | null;
    location_address?: string | null;
  },
): SavedLocation | null {
  if (candidate.latitude != null && candidate.longitude != null) {
    const byCoords = locations.find(
      (item) => item.latitude === candidate.latitude && item.longitude === candidate.longitude,
    );
    if (byCoords) {
      return byCoords;
    }
  }

  const name = candidate.location_name?.trim();
  const address = candidate.location_address?.trim();
  if (!name && !address) {
    return null;
  }

  return (
    locations.find((item) => {
      const itemName = item.name?.trim() ?? '';
      const itemAddress = item.address.trim();
      if (name && address) {
        return itemName === name && itemAddress === address;
      }
      if (name) {
        return itemName === name;
      }
      return itemAddress === address;
    }) ?? null
  );
}
