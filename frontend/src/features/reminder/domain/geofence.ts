import type { GeoPoint, LocalReminderSchedule } from './reminder';

const EARTH_RADIUS_METERS = 6_371_000;

export type GeofenceWatchMode = 'arrive' | 'return';
export type GeofenceTransition = 'no_change' | 'armed' | 'triggered';

/** Haversine 球面距离（米）。 */
export function distanceMeters(from: GeoPoint | null | undefined, to: GeoPoint): number {
  if (from == null || from.latitude == null || from.longitude == null) {
    return Number.POSITIVE_INFINITY;
  }
  const phi1 = toRadians(from.latitude);
  const phi2 = toRadians(to.latitude);
  const deltaPhi = toRadians(to.latitude - from.latitude);
  const deltaLambda = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

/**
 * 本地围栏边沿状态机：
 * - geofence_armed=false：在圈内未离开；离开后变为 armed
 * - geofence_armed=true：再次进入才 triggered
 * - mode 决定中心点语义（arrive=日程坐标，return=记录点）
 */
export function evaluateGeofence(
  schedule: LocalReminderSchedule,
  sample: GeoPoint,
  mode: GeofenceWatchMode = resolveWatchMode(schedule),
): GeofenceTransition {
  const center = resolveGeofenceCenter(schedule, mode);
  if (center == null) return 'no_change';

  const inside = distanceMeters(center, sample) <= schedule.geofence_radius_meters;
  const armed = schedule.runtime.geofence_armed;

  if (armed) {
    return inside ? 'triggered' : 'no_change';
  }
  return inside ? 'no_change' : 'armed';
}

export function resolveWatchMode(schedule: LocalReminderSchedule): GeofenceWatchMode {
  return schedule.reminder?.reminder_type === 'return_to_recorded_location' ? 'return' : 'arrive';
}

export function resolveGeofenceCenter(
  schedule: LocalReminderSchedule,
  mode: GeofenceWatchMode = resolveWatchMode(schedule),
): GeoPoint | null {
  if (mode === 'return') {
    if (schedule.runtime.recorded_location != null) {
      return schedule.runtime.recorded_location;
    }
    return null;
  }
  if (schedule.latitude == null || schedule.longitude == null) {
    return null;
  }
  return { latitude: schedule.latitude, longitude: schedule.longitude };
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
