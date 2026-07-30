import type {
  Schedule,
  ScheduleConflict,
  ScheduleListQuery,
  ScheduleListResult,
  ScheduleUpsertCommand,
  ScheduleUpsertError,
  ScheduleUpsertResult,
} from '../types/home';

export const scheduleListMock: ScheduleListResult = {
  type: 'schedule.list.result',
  request_id: 'req_schedule_list_mock',
  ok: true,
  payload: {
    schedules: [
      {
        id: 'schedule_001',
        user_id: 'default_user',
        source_mode: 'voice',
        schedule_type: 'time',
        status: 'done',
        title: '复习 Java 集合基础',
        notes: '复习 List、Set 与 Map 的常见实现。',
        start_time: '2026-07-27T08:40:00+08:00',
        end_time: '2026-07-27T09:15:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: null,
        location_address: null,
        latitude: null,
        longitude: null,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: '2026-07-27T08:25:00+08:00',
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_001',
        system_alarm_ref_id: null,
        created_at: '2026-07-26T20:10:00+08:00',
        updated_at: '2026-07-27T09:15:00+08:00',
      },
      {
        id: 'schedule_002',
        user_id: 'default_user',
        source_mode: 'manual',
        schedule_type: 'time',
        status: 'scheduled',
        title: '需求分析讨论',
        notes: null,
        start_time: '2026-07-28T14:00:00+08:00',
        end_time: '2026-07-28T14:45:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: '张江办公室',
        location_address: '上海市浦东新区张江路 88 号',
        latitude: 31.2015,
        longitude: 121.5871,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_002',
        system_alarm_ref_id: null,
        created_at: '2026-07-27T18:30:00+08:00',
        updated_at: '2026-07-27T18:30:00+08:00',
      },
      {
        id: 'schedule_003',
        user_id: 'default_user',
        source_mode: 'voice',
        schedule_type: 'time',
        status: 'done',
        title: '完成需求分析初稿',
        notes: null,
        start_time: '2026-07-29T09:25:00+08:00',
        end_time: '2026-07-29T09:50:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: null,
        location_address: null,
        latitude: null,
        longitude: null,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: '2026-07-29T09:10:00+08:00',
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_003',
        system_alarm_ref_id: null,
        created_at: '2026-07-28T21:30:00+08:00',
        updated_at: '2026-07-29T09:50:00+08:00',
      },
      {
        id: 'schedule_004',
        user_id: 'default_user',
        source_mode: 'manual',
        schedule_type: 'time',
        status: 'scheduled',
        title: '项目周会',
        notes: '同步本周进展与风险。',
        start_time: '2026-07-29T10:30:00+08:00',
        end_time: '2026-07-29T11:20:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: '3 号会议室',
        location_address: '上海市浦东新区张江路 88 号 5 楼',
        latitude: 31.2016,
        longitude: 121.587,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_004',
        system_alarm_ref_id: null,
        created_at: '2026-07-25T10:00:00+08:00',
        updated_at: '2026-07-25T10:00:00+08:00',
      },
      {
        id: 'schedule_005',
        user_id: 'default_user',
        source_mode: 'voice',
        schedule_type: 'time',
        status: 'scheduled',
        title: '复习 JVM 内存模型',
        notes: null,
        start_time: '2026-07-29T19:30:00+08:00',
        end_time: '2026-07-29T20:05:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: null,
        location_address: null,
        latitude: null,
        longitude: null,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_005',
        system_alarm_ref_id: null,
        created_at: '2026-07-28T22:00:00+08:00',
        updated_at: '2026-07-28T22:00:00+08:00',
      },
      {
        id: 'schedule_006',
        user_id: 'default_user',
        source_mode: 'manual',
        schedule_type: 'time',
        status: 'scheduled',
        title: '整理项目介绍提纲',
        notes: null,
        start_time: '2026-07-29T20:15:00+08:00',
        end_time: '2026-07-29T20:35:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: null,
        location_address: null,
        latitude: null,
        longitude: null,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_006',
        system_alarm_ref_id: null,
        created_at: '2026-07-28T22:10:00+08:00',
        updated_at: '2026-07-28T22:10:00+08:00',
      },
      {
        id: 'schedule_007',
        user_id: 'default_user',
        source_mode: 'voice',
        schedule_type: 'time',
        status: 'scheduled',
        title: '整理面试问题清单',
        notes: '优先整理并发与数据库问题。',
        start_time: '2026-07-31T19:30:00+08:00',
        end_time: '2026-07-31T20:20:00+08:00',
        timezone: 'Asia/Shanghai',
        location_name: null,
        location_address: null,
        latitude: null,
        longitude: null,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_007',
        system_alarm_ref_id: null,
        created_at: '2026-07-28T22:20:00+08:00',
        updated_at: '2026-07-28T22:20:00+08:00',
      },
      {
        id: 'schedule_008',
        user_id: 'default_user',
        source_mode: 'voice',
        schedule_type: 'location',
        status: 'scheduled',
        title: '到公司后提交实习简历',
        notes: '提交前再次检查附件命名。',
        start_time: null,
        end_time: null,
        timezone: null,
        location_name: '张江办公室',
        location_address: '上海市浦东新区张江路 88 号',
        latitude: 31.2015,
        longitude: 121.5871,
        geofence_radius_meters: 100,
        geofence_armed: true,
        time_remind_offset_minutes: 15,
        time_triggered_at: null,
        geo_triggered_at: null,
        system_schedule_ref_id: 'system_schedule_008',
        system_alarm_ref_id: null,
        created_at: '2026-07-29T08:00:00+08:00',
        updated_at: '2026-07-29T08:00:00+08:00',
      },
    ],
  },
};

export const scheduleListQueryMock: ScheduleListQuery = {
  type: 'schedule.list.query',
  request_id: 'req_schedule_list_001',
  payload: {
    status: null,
    include_deleted: false,
  },
};

export const scheduleUpsertMock: ScheduleUpsertCommand = {
  type: 'schedule.upsert.command',
  request_id: 'req_schedule_001',
  payload: {
    schedule_id: null,
    source_mode: 'voice',
    schedule_type: 'time',
    title: '开会',
    notes: null,
    start_time: '2026-07-29T15:00:00+08:00',
    end_time: null,
    timezone: 'Asia/Shanghai',
    location_name: '陆家嘴',
    location_address: null,
    latitude: 31.2451,
    longitude: 121.5067,
    geofence_radius_meters: 100,
    geofence_armed: true,
    time_remind_offset_minutes: 15,
  },
};

export const scheduleUpsertResultMock: ScheduleUpsertResult = {
  type: 'schedule.upsert.result',
  request_id: 'req_schedule_001',
  ok: true,
  payload: {
    schedule_id: 'schedule_001',
    schedule_type: 'time',
    status: 'scheduled',
    conflicts: [],
    geofence_armed: true,
  },
};

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

export function createScheduleUpsertResultMock(
  command: ScheduleUpsertCommand,
  schedules: Schedule[],
  scheduleId: string,
): ScheduleUpsertResult {
  const existingSchedule = schedules.find((item) => item.id === scheduleId);

  return {
    ...scheduleUpsertResultMock,
    request_id: command.request_id,
    payload: {
      ...scheduleUpsertResultMock.payload,
      schedule_id: scheduleId,
      schedule_type: command.payload.schedule_type,
      conflicts: findScheduleConflicts(command, schedules, scheduleId),
      geofence_armed: command.payload.geofence_armed ?? existingSchedule?.geofence_armed ?? true,
    },
  };
}

export const scheduleUpsertConflictMock: ScheduleUpsertResult = {
  type: 'schedule.upsert.result',
  request_id: 'req_schedule_001',
  ok: true,
  payload: {
    schedule_id: 'schedule_001',
    schedule_type: 'time',
    status: 'scheduled',
    conflicts: [
      {
        schedule_id: 'schedule_older',
        title: '已有日程',
        start_time: '2026-07-28T15:00:00+08:00',
        end_time: '2026-07-28T16:00:00+08:00',
      },
    ],
    geofence_armed: true,
  },
};

export const scheduleUpsertErrorMock: ScheduleUpsertError = {
  type: 'schedule.upsert.error',
  request_id: 'req_schedule_001',
  ok: false,
  error: {
    code: 'VALIDATION_ERROR',
    message: '请求参数不合法',
    details: {
      field: 'schedule_type',
      reason: 'schedule_type 为 time 时 start_time 必填；为 location 时 latitude 和 longitude 必填',
    },
  },
};
