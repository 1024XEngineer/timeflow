import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { View } from 'react-native';

import { SessionProvider } from '@/app/session/SessionProvider';
import type { DeviceIdStore } from '@/infrastructure/storage/deviceIdStore';

class TestWebSocket {
  static readonly OPEN = 1;
  static instances: TestWebSocket[] = [];

  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(_url: string) {
    TestWebSocket.instances.push(this);
  }

  send(_data: string) {}

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }
}

const deviceIdStore: DeviceIdStore = {
  get: async () => 'device_test',
  set: async () => undefined,
};

describe('SessionProvider reconnect lifecycle', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalUrl = process.env.EXPO_PUBLIC_WS_URL;

  beforeEach(() => {
    jest.useFakeTimers();
    TestWebSocket.instances = [];
    process.env.EXPO_PUBLIC_WS_URL = 'ws://test.invalid/ws';
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: TestWebSocket,
      writable: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_WS_URL;
    else process.env.EXPO_PUBLIC_WS_URL = originalUrl;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
      writable: true,
    });
  });

  it('schedules only one first retry after the session handshake times out', async () => {
    const view = render(
      <SessionProvider deviceIdStore={deviceIdStore}>
        <View />
      </SessionProvider>,
    );

    await act(async () => undefined);
    expect(TestWebSocket.instances).toHaveLength(1);

    await act(async () => {
      TestWebSocket.instances[0]?.open();
      await Promise.resolve();
    });

    act(() => {
      jest.advanceTimersByTime(10_000);
      jest.advanceTimersByTime(999);
    });
    expect(TestWebSocket.instances).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(TestWebSocket.instances).toHaveLength(2);

    view.unmount();
  });
});
