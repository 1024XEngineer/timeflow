import { describe, expect, it, jest } from '@jest/globals';

import type { AssistantServerMessage } from '../../../../../../src/contracts/conversation';
import { AuthenticatedVoiceTransport } from '../../../../../../src/features/assistant/data/websocket/AuthenticatedVoiceTransport';
import type { AuthenticatedWebSocketClient } from '../../../../../../src/infrastructure/websocket';

function createFakeClient() {
  const listeners = new Set<(data: string | ArrayBuffer) => void>();
  const client = {
    connect: jest.fn(async () => undefined),
    onClose: jest.fn(() => () => undefined),
    send: jest.fn(),
    subscribe: jest.fn((listener: (data: string | ArrayBuffer) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as AuthenticatedWebSocketClient;
  return {
    client,
    emit: (data: string | ArrayBuffer) => {
      for (const listener of listeners) listener(data);
    },
  };
}

describe('AuthenticatedVoiceTransport', () => {
  it.each([
    ['invalid JSON', '{not-json'],
    ['a bare JSON string', '"just a string"'],
    ['a bare JSON number', '42'],
    ['a JSON null', 'null'],
  ])('turns %s into a transport error instead of throwing', async (_name, frame) => {
    const fake = createFakeClient();
    const transport = new AuthenticatedVoiceTransport(fake.client);
    const connection = await transport.connect();
    const received: AssistantServerMessage[] = [];
    connection.onMessage((message) => received.push(message));

    expect(() => fake.emit(frame)).not.toThrow();
    expect(received).toEqual([
      {
        error: { code: 'MALFORMED_MESSAGE', message: expect.any(String), retryable: false },
        ok: false,
        type: 'protocol.error',
      },
    ]);
  });

  it('passes well-formed JSON frames through unchanged', async () => {
    const fake = createFakeClient();
    const transport = new AuthenticatedVoiceTransport(fake.client);
    const connection = await transport.connect();
    const received: AssistantServerMessage[] = [];
    connection.onMessage((message) => received.push(message));

    fake.emit(
      JSON.stringify({
        ok: true,
        payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
        type: 'voice.stream.started',
      }),
    );

    expect(received).toEqual([
      {
        ok: true,
        payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
        type: 'voice.stream.started',
      },
    ]);
  });
});
