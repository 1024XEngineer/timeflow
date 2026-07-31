import { describe, expect, it, jest } from '@jest/globals';

import type { WsJsonMessage } from '@/contracts';
import type { ScheduleTransport } from '@/features/schedule/data/ScheduleTransport';
import { WsScheduleRepository } from '@/features/schedule/data/WsScheduleRepository';

describe('WsScheduleRepository backend compatibility', () => {
  it('accepts the MVP delete acknowledgement without request_id', async () => {
    const request = jest.fn(
      async (
        _message: WsJsonMessage & { request_id: string },
        isMatch?: (response: WsJsonMessage) => boolean,
      ) => {
        const response = {
          type: 'schedule.deleted.ack',
          schedule_id: 'schedule_1',
          ok: true,
        };
        expect(isMatch?.(response)).toBe(true);
        return response;
      },
    );
    const transport = {
      onMessage: () => () => undefined,
      request,
      sendJson: () => undefined,
    } as unknown as ScheduleTransport;
    const repository = new WsScheduleRepository(transport);

    await expect(repository.notifyDeleted('schedule_1')).resolves.toMatchObject({ ok: true });
    repository.dispose();
  });
});
