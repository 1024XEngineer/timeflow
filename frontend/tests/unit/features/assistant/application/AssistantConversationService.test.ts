import { describe, expect, it, jest } from '@jest/globals';

import type {
  AssistantClientMessage,
  AssistantServerMessage,
} from '../../../../../src/contracts/conversation';
import { AssistantConversationService } from '../../../../../src/features/assistant/application/AssistantConversationService';
import type { AssistantAudioPlaybackPort } from '../../../../../src/features/assistant/application/interfaces/AssistantAudioPlaybackPort';
import type { AudioCapturePort } from '../../../../../src/features/assistant/application/interfaces/AudioCapturePort';
import type { LocalScheduleWriterPort } from '../../../../../src/features/assistant/application/interfaces/LocalScheduleWriterPort';
import type {
  VoiceTransportConnection,
  VoiceTransportPort,
} from '../../../../../src/features/assistant/application/interfaces/VoiceTransportPort';
import type { LocationProvider } from '../../../../../src/infrastructure/location/LocationProvider';

/**
 * _startTurn() 在真正发 voice.stream.start 之前要串好几层 await（定位的
 * Promise.race → transport.connect() → requestPermission()），每层都是一次
 * 真实的微任务跳转；固定跑够多轮 microtask flush，比猜测精确跳数要稳。
 */
async function flushAsync(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

function createFakeConnection() {
  const messageHandlers = new Set<(message: AssistantServerMessage) => void>();
  const audioHandlers = new Set<(chunk: ArrayBuffer) => void>();
  const closeHandlers = new Set<(event: { code: number; reason: string }) => void>();
  const sent: AssistantClientMessage[] = [];
  const unsubscribeCalls = { audio: 0, close: 0, message: 0 };
  const closeCalls = { count: 0 };

  const connection: VoiceTransportConnection = {
    close: () => {
      closeCalls.count += 1;
    },
    onAudioFrame: (handler) => {
      audioHandlers.add(handler);
      return () => {
        audioHandlers.delete(handler);
        unsubscribeCalls.audio += 1;
      };
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
        unsubscribeCalls.close += 1;
      };
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
        unsubscribeCalls.message += 1;
      };
    },
    send: (message) => {
      sent.push(message);
    },
    sendAudioFrame: () => undefined,
  };

  return {
    closeCalls,
    connection,
    emitClose: (event: { code: number; reason: string }) => {
      for (const handler of closeHandlers) handler(event);
    },
    emitMessage: (message: AssistantServerMessage) => {
      for (const handler of messageHandlers) handler(message);
    },
    sent,
    unsubscribeCalls,
  };
}

function createDeps(overrides: {
  connection?: VoiceTransportConnection;
  requestPermission?: () => Promise<boolean>;
  startCapture?: () => Promise<void>;
}) {
  const transport: VoiceTransportPort = {
    connect: jest.fn(async () => overrides.connection ?? createFakeConnection().connection),
  };
  const capture: AudioCapturePort = {
    requestPermission: jest.fn(overrides.requestPermission ?? (async () => true)),
    start: jest.fn(overrides.startCapture ?? (async () => undefined)),
    stop: jest.fn(async () => undefined),
  };
  const playback: AssistantAudioPlaybackPort = {
    endStream: jest.fn(async () => undefined),
    pushChunk: jest.fn(async () => undefined),
    startStream: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  };
  const location: LocationProvider = {
    getCurrentSample: jest.fn(async () => null),
  };
  const localScheduleWriter: LocalScheduleWriterPort = {
    applyCommandResult: jest.fn(async () => undefined),
  };
  return { capture, localScheduleWriter, location, playback, transport };
}

describe('AssistantConversationService', () => {
  it('never sends voice.stream.start when the microphone permission is denied', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({
      connection: fake.connection,
      requestPermission: async () => false,
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await service.startTurn();

    expect(fake.sent).toHaveLength(0);
    expect(deps.capture.start).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ message: '没有麦克风权限', phase: 'error' });
  });

  it('resolves startTurn instead of hanging when a transport error arrives before voice.stream.started', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      error: { code: 'X', message: 'boom' },
      ok: false,
    } as AssistantServerMessage);

    await expect(turn).resolves.toBeUndefined();
    expect(service.getState()).toEqual({ message: 'boom', phase: 'error' });
    expect(deps.capture.start).not.toHaveBeenCalled();
  });

  it('resolves startTurn instead of hanging when the connection closes before voice.stream.started', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await flushAsync();
    fake.emitClose({ code: 1006, reason: '' });

    await expect(turn).resolves.toBeUndefined();
    expect(service.getState()).toEqual({ message: '连接已断开（1006）', phase: 'error' });
  });

  it('endTurn does not hang waiting on a startTurn that never got voice.stream.started', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await flushAsync();
    const endTurn = service.endTurn();
    fake.emitClose({ code: 1006, reason: '' });

    await expect(Promise.all([turn, endTurn])).resolves.toBeDefined();
  });

  it('sends voice.stream.end and reports an error when capture.start() fails after the stream opened', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({
      connection: fake.connection,
      startCapture: async () => {
        throw new Error('mic busy');
      },
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      ok: true,
      payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
      type: 'voice.stream.started',
    } as AssistantServerMessage);
    await turn;

    expect(fake.sent).toContainEqual({
      payload: { stream_id: 'stream_001' },
      type: 'voice.stream.end',
    });
    expect(service.getState()).toEqual({ message: '录音启动失败', phase: 'error' });
  });

  it('dispose() unsubscribes every listener registered on the connection', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      ok: true,
      payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
      type: 'voice.stream.started',
    } as AssistantServerMessage);
    await turn;

    service.dispose();

    expect(fake.unsubscribeCalls).toEqual({ audio: 1, close: 1, message: 1 });
    expect(fake.closeCalls.count).toBe(1);
  });
});
