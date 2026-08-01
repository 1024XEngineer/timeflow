import type { MapLocation } from '../types';

export type { MapLocation };

export type MapPickerProps = {
  initialLocation: MapLocation | null;
  onCancel: () => void;
  onConfirm: (location: MapLocation) => void;
};
