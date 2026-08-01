export type MapLocation = {
  address: string;
  latitude: number;
  longitude: number;
  name?: string;
};

export type MapPickerProps = {
  initialLocation: MapLocation | null;
  onCancel: () => void;
  onConfirm: (location: MapLocation) => void;
};
