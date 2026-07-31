import { describe, expect, it, jest } from '@jest/globals';

import { FakeWsServer } from '@/dev/fakes/FakeWsServer';
import {
  LocationReporter,
  type LocationTransport,
} from '@/infrastructure/location/LocationReporter';
import { WsClient } from '@/infrastructure/ws/WsClient';

describe('LocationReporter', () => {
  it('reports location when armed and receives ack', async () => {
    const server = new FakeWsServer();
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();

    const sample = jest.fn(async () => ({
      latitude: 31.2,
      longitude: 121.5,
      accuracy: 10,
    }));
    const reporter = new LocationReporter(client, sample);
    const ack = await reporter.report({
      latitude: 31.2,
      longitude: 121.5,
      accuracy: 10,
    });
    expect(ack.ok).toBe(true);
    reporter.stop();
    client.close();
  });

  it('surfaces a rejected location acknowledgement to the reporter', async () => {
    const client = {
      request: jest.fn(async () => ({
        type: 'location.report.ack' as const,
        request_id: 'req_location_failure',
        ok: false as const,
        error: { code: 'denied', message: '定位上报被拒绝', details: null },
      })),
    } as unknown as LocationTransport;
    const reporter = new LocationReporter(client, async () => null);

    await expect(
      reporter.report({ latitude: 31.2, longitude: 121.5, accuracy: 10 }),
    ).rejects.toThrow('定位上报被拒绝');
  });
});
