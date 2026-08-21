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
import type { AppStateProvider } from '../../../../../src/infrastructure/appState/AppStateProvider';
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

async function advanceAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushAsync();
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
    emitAudioFrame: (chunk: ArrayBuffer) => {
      for (const handler of audioHandlers) handler(chunk);
    },
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
  applyCommandResult?: () => Promise<void>;
  applyCategoryUpdate?: () => Promise<boolean>;
  connection?: VoiceTransportConnection;
  getCurrentSample?: LocationProvider['getCurrentSample'];
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
    getCurrentSample: jest.fn(overrides.getCurrentSample ?? (async () => null)),
  };
  const localScheduleWriter: LocalScheduleWriterPort = {
    applyCommandResult: jest.fn(overrides.applyCommandResult ?? (async () => undefined)),
    applyCategoryUpdate: jest.fn(overrides.applyCategoryUpdate ?? (async () => true)),
  };
  const appState: AppStateProvider = {
    subscribe: jest.fn(() => () => undefined),
  };
  return { appState, capture, localScheduleWriter, location, playback, transport };
}

async function completeStreamStart(
  fake: ReturnType<typeof createFakeConnection>,
  turn: Promise<void>,
): Promise<void> {
  await flushAsync();
  fake.emitMessage({
    ok: true,
    payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
    type: 'voice.stream.started',
  } as AssistantServerMessage);
  await turn;
}

describe('AssistantConversationService', () => {
  it('does not hold the push-to-talk button on a slow location sample', async () => {
    jest.useFakeTimers();
    try {
      const fake = createFakeConnection();
      const deps = createDeps({
        connection: fake.connection,
        getCurrentSample: () => new Promise(() => undefined),
      });
      const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

      const turn = service.startTurn();
      await advanceAndFlush(499);
      expect(deps.transport.connect).not.toHaveBeenCalled();

      await advanceAndFlush(1);
      expect(deps.transport.connect).toHaveBeenCalledWith(null);

      fake.emitMessage({
        ok: true,
        payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
        type: 'voice.stream.started',
      } as AssistantServerMessage);
      await turn;
    } finally {
      jest.useRealTimers();
    }
  });

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

  it('unsubscribes the old push-to-talk listeners after a mode-switch disconnect', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    // AuthenticatedWebSocketClient 切到 continuous 时会关掉当前这条 push_to_talk 连接。
    fake.emitClose({ code: 1000, reason: '' });
    expect(fake.unsubscribeCalls).toEqual({ audio: 1, close: 1, message: 1 });

    // 新连接上的 TTS：旧服务不能再收到，否则会和连续对话服务重叠播放。
    fake.emitMessage({
      audio_id: 'audio_002',
      conversation_id: 'conv_002',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    fake.emitAudioFrame(new ArrayBuffer(4));

    expect(deps.playback.startStream).not.toHaveBeenCalled();
    expect(deps.playback.pushChunk).not.toHaveBeenCalled();
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

  it('sends message.ack only after the local write succeeds', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_001',
      payload: { operation: 'create_schedule', status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(fake.sent).toContainEqual({
      message_id: 'msg_001',
      status: 'applied',
      type: 'message.ack',
    });
    expect(service.getLastAppliedCommand()).toEqual({
      operation: 'create_schedule',
      schedule: undefined,
      schedules: undefined,
      status: 'applied',
    });
  });

  it('withholds message.ack when the local write fails', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({
      applyCommandResult: async () => {
        throw new Error('disk full');
      },
      connection: fake.connection,
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_001',
      payload: { operation: 'create_schedule', status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(fake.sent).not.toContainEqual(expect.objectContaining({ type: 'message.ack' }));
    expect(service.getLastAppliedCommand()).toBeNull();
  });

  it('keeps applying queued command results even if a subscriber listener throws', async () => {
    // markScheduleDataChanged() synchronously notifies every subscriber; a listener
    // that throws (e.g. a buggy re-render) rejects applyCommandResultLocally()'s
    // promise. queueCommandResult() must neutralize that with .catch(() => {})
    // chained in the same statement (same idiom as
    // AssistantContinuousConversationService/chainPlayback) -- deferring the catch
    // leaves the rejection unhandled for a few microtask ticks, which crashes the
    // process outright (reproduced while writing this test, before adding the
    // immediate .catch()).
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    // handleMessage's own setState() notifies once synchronously before
    // applyCommandResultLocally's markScheduleDataChanged() notifies again
    // asynchronously; only the second one is the one queueCommandResult's chain
    // needs to survive.
    let notifyCount = 0;
    const unsubscribe = service.subscribe(() => {
      notifyCount += 1;
      if (notifyCount === 2) {
        throw new Error('listener boom');
      }
    });
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_1',
      payload: { operation: 'create_schedule', schedule: { id: 'a' }, status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();
    unsubscribe();

    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_2',
      payload: { operation: 'create_schedule', schedule: { id: 'b' }, status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getLastAppliedCommand()).toEqual(
      expect.objectContaining({ operation: 'create_schedule', schedule: { id: 'b' } }),
    );
  });

  it('serializes local writes so a batch of back-to-back command results cannot race', async () => {
    // Regression test: a single utterance can make the model call several tools in
    // one turn, so voice.command.result messages can arrive only milliseconds
    // apart. Each write opens its own withExclusiveTransactionAsync() on the real
    // SQLite adapter -- running two at once opens two native connections that
    // fight over the same exclusive lock ("database is locked"), and the loser's
    // write is silently dropped even though the cloud already committed it.
    // queueCommandResult() must serialize these instead of firing them
    // concurrently.
    const fake = createFakeConnection();
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    let inFlight = 0;
    let overlapped = false;
    let callCount = 0;
    const deps = createDeps({
      applyCommandResult: async () => {
        callCount += 1;
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        if (callCount === 1) {
          order.push('first-start');
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
          order.push('first-end');
        } else {
          order.push('second-start');
          order.push('second-end');
        }
        inFlight -= 1;
      },
      connection: fake.connection,
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_1',
      payload: { operation: 'create_schedule', schedule: { id: 'a' }, status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_2',
      payload: { operation: 'create_schedule', schedule: { id: 'b' }, status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    // The second write must not have started yet -- the first is still stuck
    // mid-transaction, waiting on resolveFirst.
    expect(order).toEqual(['first-start']);
    expect(overlapped).toBe(false);

    resolveFirst?.();
    await flushAsync();

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    expect(overlapped).toBe(false);
    expect(fake.sent).toContainEqual(
      expect.objectContaining({ message_id: 'msg_1', type: 'message.ack' }),
    );
    expect(fake.sent).toContainEqual(
      expect.objectContaining({ message_id: 'msg_2', type: 'message.ack' }),
    );
  });

  it('patches an asynchronous category update without requiring a revision change', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);
    expect(service.getScheduleDataRevision()).toBe(0);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();

    expect(deps.localScheduleWriter.applyCategoryUpdate).toHaveBeenCalledWith(
      'acc_001',
      'schedule_001',
      'work',
    );
    expect(service.getScheduleDataRevision()).toBe(1);
  });

  it('buffers a category event that arrives before the command result', async () => {
    const fake = createFakeConnection();
    const applyCategoryUpdate = jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deps = createDeps({ applyCategoryUpdate, connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_001',
      payload: {
        operation: 'create_schedule',
        schedule: { id: 'schedule_001' },
        status: 'applied',
      },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(applyCategoryUpdate).toHaveBeenNthCalledWith(2, 'acc_001', 'schedule_001', 'work');
  });

  it('retries a category event after a command result local write finishes', async () => {
    const fake = createFakeConnection();
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const applyCategoryUpdate = jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deps = createDeps({
      applyCategoryUpdate,
      applyCommandResult: () => writePending,
      connection: fake.connection,
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_001',
      payload: {
        operation: 'create_schedule',
        schedule: { id: 'schedule_001' },
        status: 'applied',
      },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();
    finishWrite();
    await flushAsync();

    expect(applyCategoryUpdate).toHaveBeenNthCalledWith(2, 'acc_001', 'schedule_001', 'work');
  });

  it('keeps the latest pending category when category events overlap', async () => {
    const fake = createFakeConnection();
    let finishFirst!: () => void;
    const firstWrite = new Promise<boolean>((resolve) => {
      finishFirst = () => resolve(false);
    });
    const applyCategoryUpdate = jest
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deps = createDeps({ applyCategoryUpdate, connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    fake.emitMessage({
      payload: { category: 'study', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();
    finishFirst();
    await flushAsync();

    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_001',
      payload: {
        operation: 'create_schedule',
        schedule: { id: 'schedule_001' },
        status: 'applied',
      },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(applyCategoryUpdate).toHaveBeenNthCalledWith(3, 'acc_001', 'schedule_001', 'study');
  });

  it('does not recreate pending state after dispose during a category patch', async () => {
    const fake = createFakeConnection();
    let finishWrite!: () => void;
    const pendingWrite = new Promise<boolean>((resolve) => {
      finishWrite = () => resolve(false);
    });
    const applyCategoryUpdate = jest.fn<() => Promise<boolean>>(() => pendingWrite);
    const deps = createDeps({ applyCategoryUpdate, connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();
    service.dispose();
    finishWrite();
    await flushAsync();

    expect(applyCategoryUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed asynchronous category patch', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({
      applyCategoryUpdate: async () => {
        throw new Error('disk full');
      },
      connection: fake.connection,
    });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const turn = service.startTurn();
    await completeStreamStart(fake, turn);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getState()).toMatchObject({ phase: 'recording' });
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
