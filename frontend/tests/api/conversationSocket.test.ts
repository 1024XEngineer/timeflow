import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ConversationServerEvent } from '../../src/api/contracts/conversation';
import {
  classifyConversationClose,
  ConversationSocket,
} from '../../src/api/core/ConversationSocket';
import {
  mockConfirmationEvent,
  mockMessageId,
  mockProcessingEvent,
  mockTimestamp,
} from './mockData';

interface MockSocketOptions {
  headers?: Record<string, string>;
}

class MockWebSocket {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static lastInstance: MockWebSocket | null = null;

  readonly options?: MockSocketOptions;
  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string, _protocols?: string | string[], options?: MockSocketOptions) {
    this.url = url;
    this.options = options;
    MockWebSocket.lastInstance = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  MockWebSocket.lastInstance = null;
});

describe('ConversationSocket latest Wiki envelope', () => {
  it('authenticates the handshake and sends type/timestamp/payload only', () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const conversation = new ConversationSocket({
      accessToken: 'mock.jwt.token',
      url: 'ws://example.test/ws/v1/conversation',
      onEvent: () => undefined,
    });

    conversation.connect();
    const socket = MockWebSocket.lastInstance;
    assert.ok(socket);
    assert.equal(socket.options?.headers?.Authorization, 'Bearer mock.jwt.token');
    socket.readyState = MockWebSocket.OPEN;

    const event = {
      type: 'selection.submit' as const,
      timestamp: mockTimestamp,
      payload: {
        interaction_id: 'interaction-01',
        selected_candidate_ids: ['candidate-01'],
      },
    };
    conversation.send(event);

    assert.deepEqual(JSON.parse(socket.sent[0]), event);
    assert.deepEqual(Object.keys(JSON.parse(socket.sent[0])).sort(), [
      'payload',
      'timestamp',
      'type',
    ]);
  });

  it('dispatches documented processing and confirmation events', () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const received: ConversationServerEvent[] = [];
    const conversation = new ConversationSocket({
      accessToken: 'mock.jwt.token',
      onEvent: (event) => received.push(event),
    });

    conversation.connect();
    const socket = MockWebSocket.lastInstance;
    assert.ok(socket);
    socket.onmessage?.({ data: JSON.stringify(mockProcessingEvent) } as MessageEvent);
    socket.onmessage?.({ data: JSON.stringify(mockConfirmationEvent) } as MessageEvent);

    assert.deepEqual(received, [mockProcessingEvent, mockConfirmationEvent]);
  });

  it('sends transport.resume after a reconnect', () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const conversation = new ConversationSocket({
      accessToken: 'mock.jwt.token',
      onEvent: () => undefined,
    });
    conversation.connect();
    const socket = MockWebSocket.lastInstance;
    assert.ok(socket);
    socket.readyState = MockWebSocket.OPEN;

    conversation.resume(mockMessageId);
    const sent = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    assert.equal(sent.type, 'transport.resume');
    assert.deepEqual(sent.payload, { last_seen_message_id: mockMessageId });
  });

  it('maps malformed server events to a local execution.error event', () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const received: ConversationServerEvent[] = [];
    const conversation = new ConversationSocket({
      accessToken: 'mock.jwt.token',
      onEvent: (event) => received.push(event),
    });
    conversation.connect();
    const socket = MockWebSocket.lastInstance;
    assert.ok(socket);

    socket.onmessage?.({ data: '{"event":"old-envelope"}' } as MessageEvent);

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'execution.error');
    if (received[0].type === 'execution.error') {
      assert.equal(received[0].payload.error_code, 'CONTRACT_MISMATCH');
    }
  });

  it('classifies normal, authentication, and reconnect close cases', () => {
    assert.equal(classifyConversationClose({ code: 1000, wasClean: true } as CloseEvent), 'closed');
    assert.equal(
      classifyConversationClose({ code: 1008, wasClean: true } as CloseEvent),
      'reauthenticate',
    );
    assert.equal(
      classifyConversationClose({ code: 1011, wasClean: false } as CloseEvent),
      'reconnect',
    );
    assert.equal(
      classifyConversationClose({ code: 1006, wasClean: false } as CloseEvent),
      'reconnect',
    );
  });
});
