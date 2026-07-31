import type {
  Schedule,
  ScheduleConflict,
  ScheduleUpsertCommand,
  ScheduleUpsertResult,
} from '@/contracts';

/** 检测与现有日程的时间重叠冲突（排除自身与已删除项）。 */
function findScheduleConflicts(
  command: ScheduleUpsertCommand,
  schedules: Schedule[],
  currentScheduleId: string,
): ScheduleConflict[] {
  const { end_time: endTime, start_time: startTime } = command.payload;
  if (!startTime) return [];

  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  return schedules
    .filter((item) => item.id !== currentScheduleId && item.status !== 'deleted' && item.start_time)
    .filter((item) => {
      const itemStart = new Date(item.start_time!).getTime();
      const itemEnd = item.end_time ? new Date(item.end_time).getTime() : itemStart;
      return (
        Number.isFinite(itemStart) &&
        Number.isFinite(itemEnd) &&
        start <= itemEnd &&
        itemStart <= end
      );
    })
    .map((item) => ({
      schedule_id: item.id,
      title: item.title,
      start_time: item.start_time!,
      end_time: item.end_time,
    }));
}

/** 拼装本地 upsert 结果（含冲突列表与 geofence 默认值）。 */
export function upsertSchedule(
  command: ScheduleUpsertCommand,
  current: Schedule[],
  scheduleId: string,
): ScheduleUpsertResult {
  const existingSchedule = current.find((item) => item.id === scheduleId);

  return {
    type: 'schedule.upsert.result',
    request_id: command.request_id,
    ok: true,
    payload: {
      schedule_id: scheduleId,
      schedule_type: command.payload.schedule_type,
      status: 'scheduled',
      conflicts: findScheduleConflicts(command, current, scheduleId),
      geofence_armed: command.payload.geofence_armed ?? existingSchedule?.geofence_armed ?? true,
    },
  };
}
