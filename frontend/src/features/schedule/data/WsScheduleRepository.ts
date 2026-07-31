import type {
  Schedule,
  ScheduleDeleted,
  ScheduleDeletedAck,
  ScheduleListQuery,
  ScheduleListResponse,
  ScheduleListQueryPayload,
  ScheduleStatus,
  ScheduleStatusUpdateCommand,
  ScheduleStatusUpdateResponse,
  ScheduleUpsertCommand,
  ScheduleUpsertResponse,
  WsJsonMessage,
} from '@/contracts';
import { nextRequestId } from '@/shared/utils/requestId';

import type { SchedulePushEvent, ScheduleRepositoryPort } from './ScheduleRepositoryPort';
import type { ScheduleTransport } from './ScheduleTransport';

export class WsScheduleRepository implements ScheduleRepositoryPort {
  private readonly listeners = new Set<(event: SchedulePushEvent) => void>();
  private readonly unsubscribeClient: () => void;

  constructor(private readonly client: ScheduleTransport) {
    this.unsubscribeClient = this.client.onMessage((message) => {
      if (message instanceof ArrayBuffer) return;
      this.routePush(message);
    });
  }

  dispose(): void {
    this.unsubscribeClient();
    this.listeners.clear();
  }

  async list(query: ScheduleListQueryPayload): Promise<Schedule[]> {
    const request: ScheduleListQuery = {
      type: 'schedule.list.query',
      request_id: nextRequestId('req_list'),
      payload: query,
    };
    const response = await this.client.request<ScheduleListResponse>(request, (message) => {
      return (
        message.request_id === request.request_id &&
        (message.type === 'schedule.list.result' || message.type === 'schedule.list.error')
      );
    });
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.payload.schedules;
  }

  async upsert(command: ScheduleUpsertCommand): Promise<ScheduleUpsertResponse> {
    return this.client.request<ScheduleUpsertResponse>(command, (message) => {
      return (
        message.request_id === command.request_id &&
        (message.type === 'schedule.upsert.result' || message.type === 'schedule.upsert.error')
      );
    });
  }

  async updateStatus(
    scheduleId: string,
    status: Extract<ScheduleStatus, 'scheduled' | 'done'>,
  ): Promise<ScheduleStatusUpdateResponse> {
    const command: ScheduleStatusUpdateCommand = {
      type: 'schedule.status.command',
      request_id: nextRequestId('req_status'),
      payload: { schedule_id: scheduleId, status },
    };
    return this.client.request<ScheduleStatusUpdateResponse>(command, (message) => {
      return (
        message.request_id === command.request_id &&
        (message.type === 'schedule.status.result' || message.type === 'schedule.status.error')
      );
    });
  }

  async notifyDeleted(scheduleId: string): Promise<ScheduleDeletedAck> {
    const command: ScheduleDeleted = {
      type: 'schedule.deleted',
      request_id: nextRequestId('req_deleted'),
      schedule_id: scheduleId,
      deleted: true,
      timestamp: new Date().toISOString(),
    };
    // 先登记 pending 再发送，避免 Fake 同步 ACK 竞态。
    return this.client.request<ScheduleDeletedAck>(command, (message) => {
      return (
        message.type === 'schedule.deleted.ack' &&
        (message.request_id == null || message.request_id === command.request_id) &&
        message.schedule_id === scheduleId
      );
    });
  }

  subscribe(listener: (event: SchedulePushEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private routePush(message: WsJsonMessage): void {
    if (message.type === 'schedule.updated' && message.schedule) {
      const event: SchedulePushEvent = {
        type: 'schedule.updated',
        schedule: message.schedule as Schedule,
      };
      for (const listener of this.listeners) listener(event);
    }
  }
}
