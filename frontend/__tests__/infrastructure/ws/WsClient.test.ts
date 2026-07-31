import { describe, expect, it } from '@jest/globals';

import { FakeWsServer } from '@/dev/fakes/FakeWsServer';
import { WsClient } from '@/infrastructure/ws/WsClient';
import { makeSchedule } from '@test/fixtures';

describe('WsClient + FakeWsServer', () => {
  it('completes session hello and lists schedules', async () => {
    const server = new FakeWsServer({ userId: 'user_test' });
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();

    const ready = new Promise<void>((resolve) => {
      client.onMessage((message) => {
        if (!(message instanceof ArrayBuffer) && message.type === 'session.ready') {
          resolve();
        }
      });
    });
    client.sendJson({
      type: 'session.hello',
      device_id: 'device_1',
      app_version: '1.0.0',
    });
    await ready;

    const list = await client.request({
      type: 'schedule.list.query',
      request_id: 'req_list_1',
      payload: { status: null, include_deleted: false },
    });
    expect(list.type).toBe('schedule.list.result');
    expect(list.ok).toBe(true);
    client.close();
  });

  it('upserts a schedule through fake WS', async () => {
    const server = new FakeWsServer({ userId: 'user_test' });
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();

    const response = await client.request({
      type: 'schedule.upsert.command',
      request_id: 'req_up_1',
      payload: {
        source_mode: 'manual',
        schedule_type: 'time',
        title: '测试',
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(response.ok).toBe(true);
    expect(server.getSchedules()).toHaveLength(1);
    client.close();
  });

  it('acks delete without losing synchronous fake replies', async () => {
    const server = new FakeWsServer({
      userId: 'user_test',
      seedSchedules: [makeSchedule({ id: 'del_sync', user_id: 'user_test' })],
    });
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();

    const ack = await client.request({
      type: 'schedule.deleted',
      request_id: 'req_del_sync',
      schedule_id: 'del_sync',
      deleted: true,
      timestamp: new Date().toISOString(),
    });
    expect(ack.type).toBe('schedule.deleted.ack');
    expect(ack.ok).toBe(true);
    expect(server.getSchedules()[0]?.status).toBe('deleted');
    client.close();
  });

  it('updates status to done without marking deleted', async () => {
    const server = new FakeWsServer({
      userId: 'user_test',
      seedSchedules: [makeSchedule({ id: 'status_1', user_id: 'user_test' })],
    });
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();

    const response = await client.request({
      type: 'schedule.status.command',
      request_id: 'req_status_1',
      payload: { schedule_id: 'status_1', status: 'done' },
    });
    expect(response.ok).toBe(true);
    expect(server.getSchedules()[0]?.status).toBe('done');
    client.close();
  });

  it('rejects pending requests immediately when the remote socket closes unexpectedly', async () => {
    class TestWebSocket {
      static readonly OPEN = 1;
      static instance: TestWebSocket | null = null;

      binaryType = '';
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;

      constructor(_url: string) {
        TestWebSocket.instance = this;
      }

      send(_data: string | ArrayBuffer) {}

      close() {
        this.readyState = 3;
        this.onclose?.();
      }

      open() {
        this.readyState = TestWebSocket.OPEN;
        this.onopen?.();
      }

      closeUnexpectedly() {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    const originalWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: TestWebSocket,
      writable: true,
    });

    try {
      const client = new WsClient({ url: 'ws://test.invalid', requestTimeoutMs: 60_000 });
      const connecting = client.connect();
      TestWebSocket.instance?.open();
      await connecting;

      const pending = client.request({
        type: 'schedule.list.query',
        request_id: 'req_disconnect',
        payload: { status: null, include_deleted: false },
      });
      TestWebSocket.instance?.closeUnexpectedly();

      await expect(pending).rejects.toThrow('WebSocket closed unexpectedly');
      expect(client.getConnectionStatus()).toBe('closed');
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        value: originalWebSocket,
        writable: true,
      });
    }
  });
});
