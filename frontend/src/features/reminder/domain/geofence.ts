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

/** local_schedules 表没有单独的半径列，地点提醒目前全局统一用这个值——改这里
 * 就是改全部地点提醒的实际触发半径，跟下面轮询密度用的门槛是同一个数字。 */
export const DEFAULT_GEOFENCE_RADIUS_METERS = 400;

/** 离围栏边界（不是中心点）≤ 此距离时，按最密的轮询间隔查。门槛直接等于围栏
 * 半径本身：沿着半径这段路程加密轮询，正好在真正跨过边界前进入最密档。之前
 * 这里是个跟半径无关的固定值（50m）——半径 200m 时，走到中心 50m 外都还没到
 * 最密档，可那时候早就已经越过 200m 的触发边界很久了，最密档形同虚设。 */
const GUARD_POLL_NEAR_METERS = DEFAULT_GEOFENCE_RADIUS_METERS;
/** 离围栏边界 ≥ 此距离时，按最疏的轮询间隔查。 */
const GUARD_POLL_FAR_METERS = 2_000;
/** 最密轮询间隔：贴近围栏边界时，尽量不错过穿越的瞬间。 */
const GUARD_POLL_MIN_INTERVAL_MS = 15_000;
/** 最疏轮询间隔：离目标很远时没必要频繁定位，省电。 */
const GUARD_POLL_MAX_INTERVAL_MS = 300_000;

/**
 * 常驻前台服务里持续定位的轮询间隔：离最近的地点提醒目标的围栏边界越近，查得
 * 越勤；远离时退到最疏间隔省电。传入的是"离边界还有多远"（distanceToCenter
 * - 半径，下界 0），不是离中心点多远——已经在圈内时这个值天然是 0，自动落进
 * 最密档，不需要额外判断"进圈之后要不要继续加密"。半径这一端和 2000m 那一端
 * 两个端点截断，中间线性插值。传 Infinity（没有任何地点提醒在监听）时返回
 * 最疏间隔。
 */
export function resolveGuardPollIntervalMs(distanceToNearestBoundaryMeters: number): number {
  if (
    !Number.isFinite(distanceToNearestBoundaryMeters) ||
    distanceToNearestBoundaryMeters >= GUARD_POLL_FAR_METERS
  ) {
    return GUARD_POLL_MAX_INTERVAL_MS;
  }
  if (distanceToNearestBoundaryMeters <= GUARD_POLL_NEAR_METERS) {
    return GUARD_POLL_MIN_INTERVAL_MS;
  }
  const ratio =
    (distanceToNearestBoundaryMeters - GUARD_POLL_NEAR_METERS) /
    (GUARD_POLL_FAR_METERS - GUARD_POLL_NEAR_METERS);
  return Math.round(
    GUARD_POLL_MIN_INTERVAL_MS + ratio * (GUARD_POLL_MAX_INTERVAL_MS - GUARD_POLL_MIN_INTERVAL_MS),
  );
}
