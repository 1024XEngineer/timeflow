import type {
  LocationReport,
  LocationReportAck,
  Schedule,
  ScheduleDeleted,
  ScheduleDeletedAck,
  ScheduleListQuery,
  ScheduleListResponse,
  ScheduleStatusUpdateCommand,
  ScheduleStatusUpdateResponse,
  ScheduleUpsertCommand,
  ScheduleUpsertResponse,
  SessionHello,
  SessionReady,
  VoiceParseResultMessage,
  VoiceStreamEndCommand,
  VoiceStreamStartCommand,
  VoiceStreamStartResponse,
  VoiceStreamEndResponse,
  WsJsonMessage,
} from '@/contracts';
import type { WsClient } from '@/infrastructure/ws/WsClient';

import { upsertSchedule } from './schedule/scheduleConflicts';
import { createFakeSchedule } from './schedule/scheduleFactory';

type FakeWsServerOptions = {
  userId?: string;
  seedSchedules?: Schedule[];
};

/**
 * 进程内 Fake WS：只依赖 contracts + WsClient，供本地与测试使用。
 */
export class FakeWsServer {
  private readonly schedules = new Map<string, Schedule>();
  private readonly voiceStreams = new Map<string, { jobId: string; startRequestId: string }>();
  private readonly userId: string;
  private client: WsClient | null = null;
  private voiceJobCounter = 0;

  constructor(options: FakeWsServerOptions = {}) {
    this.userId = options.userId ?? 'user_fake_1';
    for (const schedule of options.seedSchedules ?? []) {
      this.schedules.set(schedule.id, schedule);
    }
  }

  attach(client: WsClient): void {
    this.client = client;
  }

  getUserId(): string {
    return this.userId;
  }

  getSchedules(): Schedule[] {
    return [...this.schedules.values()];
  }

  handleMessage = async (message: WsJsonMessage | ArrayBuffer): Promise<void> => {
    if (message instanceof ArrayBuffer) {
      return;
    }

    switch (message.type) {
      case 'session.hello':
        this.handleSessionHello(message as SessionHello);
        return;
      case 'schedule.list.query':
        this.handleList(message as ScheduleListQuery);
        return;
      case 'schedule.upsert.command':
        this.handleUpsert(message as ScheduleUpsertCommand);
        return;
      case 'schedule.status.command':
        this.handleStatusUpdate(message as ScheduleStatusUpdateCommand);
        return;
      case 'schedule.deleted':
        this.handleDeleted(message as ScheduleDeleted);
        return;
      case 'location.report':
        this.handleLocationReport(message as LocationReport);
        return;
      case 'voice.stream.start':
        this.handleVoiceStart(message as VoiceStreamStartCommand);
        return;
      case 'voice.stream.end':
        this.handleVoiceEnd(message as VoiceStreamEndCommand);
        return;
      default:
        return;
    }
  };

  private reply(message: WsJsonMessage): void {
    this.client?.emitFromServer(message);
  }

  private handleSessionHello(message: SessionHello): void {
    const ready: SessionReady = {
      type: 'session.ready',
      device_id: message.device_id,
      user_id: this.userId,
      server_time: new Date().toISOString(),
    };
    this.reply(ready);
  }

  private handleList(message: ScheduleListQuery): void {
    const includeDeleted = message.payload.include_deleted;
    const statusFilter = message.payload.status;
    const schedules = [...this.schedules.values()].filter((item) => {
      if (!includeDeleted && item.status === 'deleted') return false;
      if (statusFilter && item.status !== statusFilter) return false;
      return true;
    });
    const response: ScheduleListResponse = {
      type: 'schedule.list.result',
      request_id: message.request_id,
      ok: true,
      payload: { schedules },
    };
    this.reply(response);
  }

  private handleUpsert(message: ScheduleUpsertCommand): void {
    const scheduleId = message.payload.schedule_id ?? `schedule_${Date.now()}`;
    const current = [...this.schedules.values()];
    const existing = this.schedules.get(scheduleId) ?? null;
    const result = upsertSchedule(message, current, scheduleId);
    const entity = createFakeSchedule({
      draft: { ...message.payload, schedule_id: scheduleId },
      scheduleId,
      userId: this.userId,
      status: result.payload.status,
      geofenceArmed: result.payload.geofence_armed,
      existing,
    });
    this.schedules.set(scheduleId, entity);
    const response: ScheduleUpsertResponse = result;
    this.reply(response);
    this.reply({
      type: 'schedule.updated',
      schedule: entity,
    });
  }

  private handleStatusUpdate(message: ScheduleStatusUpdateCommand): void {
    const existing = this.schedules.get(message.payload.schedule_id);
    if (!existing || existing.status === 'deleted') {
      const response: ScheduleStatusUpdateResponse = {
        type: 'schedule.status.error',
        request_id: message.request_id,
        ok: false,
        error: {
          code: 'schedule_not_found',
          message: '日程不存在或已删除',
          details: null,
        },
      };
      this.reply(response);
      return;
    }

    const next: Schedule = {
      ...existing,
      status: message.payload.status,
      updated_at: new Date().toISOString(),
    };
    this.schedules.set(next.id, next);
    const response: ScheduleStatusUpdateResponse = {
      type: 'schedule.status.result',
      request_id: message.request_id,
      ok: true,
      payload: { schedule_id: next.id, status: next.status },
    };
    this.reply(response);
    this.reply({ type: 'schedule.updated', schedule: next });
  }

  private handleDeleted(message: ScheduleDeleted): void {
    const existing = this.schedules.get(message.schedule_id);
    if (existing) {
      const next: Schedule = {
        ...existing,
        status: 'deleted',
        updated_at: new Date().toISOString(),
      };
      this.schedules.set(message.schedule_id, next);
      this.reply({ type: 'schedule.updated', schedule: next });
    }
    const ack: ScheduleDeletedAck = {
      type: 'schedule.deleted.ack',
      request_id: message.request_id,
      schedule_id: message.schedule_id,
      ok: true,
    };
    this.reply(ack);
  }

  private handleLocationReport(_message: LocationReport): void {
    const ack: LocationReportAck = {
      type: 'location.report.ack',
      ok: true,
    };
    this.reply(ack);
  }

  private handleVoiceStart(message: VoiceStreamStartCommand): void {
    this.voiceJobCounter += 1;
    const streamId = `stream_${this.voiceJobCounter}`;
    const jobId = `job_${this.voiceJobCounter}`;
    this.voiceStreams.set(streamId, { jobId, startRequestId: message.request_id });
    const response: VoiceStreamStartResponse = {
      type: 'voice.stream.started',
      request_id: message.request_id,
      ok: true,
      payload: { stream_id: streamId, job_id: jobId },
    };
    this.reply(response);
  }

  private handleVoiceEnd(message: VoiceStreamEndCommand): void {
    const stream = this.voiceStreams.get(message.payload.stream_id);
    if (!stream) {
      this.reply({
        type: 'voice.stream.error',
        request_id: message.request_id,
        ok: false,
        error: {
          code: 'stream_not_found',
          message: '语音流不存在或已结束',
          details: null,
        },
      });
      return;
    }
    this.voiceStreams.delete(message.payload.stream_id);
    const response: VoiceStreamEndResponse = {
      type: 'voice.stream.ended',
      request_id: message.request_id,
      ok: true,
      payload: {
        stream_id: message.payload.stream_id,
        job_id: stream.jobId,
        status: 'processing',
      },
    };
    this.reply(response);

    const parseResult: VoiceParseResultMessage = {
      type: 'voice.parse.result',
      request_id: stream.startRequestId,
      job_id: stream.jobId,
      status: 'ready_for_confirmation',
      draft: {
        schedule_type: 'time',
        title: '语音创建的日程',
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        end_time: null,
        timezone: 'Asia/Shanghai',
        time_remind_offset_minutes: 0,
      },
      missing_fields: [],
      ambiguous_fields: [],
      needs_confirmation: true,
    };
    setTimeout(() => this.reply(parseResult), 0);
  }

  private handleVoiceCancel(message: VoiceStreamCancelCommand): void {
    this.voiceStreams.delete(message.payload.stream_id);
    this.reply({
      type: 'voice.stream.cancelled',
      request_id: message.request_id,
      ok: true,
      payload: { stream_id: message.payload.stream_id },
    });
  }
}
