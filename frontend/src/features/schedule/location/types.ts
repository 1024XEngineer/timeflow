import type { MapLocation } from '@/shared/types/geo';

export type { MapLocation };

export type SavedLocation = MapLocation & {
  id: string;
};
