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

  it('returns to idle immediately and allows a new turn while the canceled connection finishes', async () => {
    const oldFake = createFakeConnection();
    const nextFake = createFakeConnection();
    let resolveOldConnection!: (connection: VoiceTransportConnection) => void;
    const oldConnectionPending = new Promise<VoiceTransportConnection>((resolve) => {
      resolveOldConnection = resolve;
    });
    const deps = createDeps({ connection: oldFake.connection });
    deps.transport.connect = jest
      .fn<VoiceTransportPort['connect']>()
      .mockReturnValueOnce(oldConnectionPending)
      .mockResolvedValueOnce(nextFake.connection);
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    const firstTurn = service.startTurn();
    await flushAsync();
    const cancel = service.cancelTurn();
    expect(service.getState()).toEqual({ phase: 'idle' });

    const nextTurn = service.startTurn();
    await flushAsync();
    expect(deps.transport.connect).toHaveBeenCalledTimes(2);

    resolveOldConnection(oldFake.connection);
    await expect(Promise.all([firstTurn, cancel])).resolves.toBeDefined();
    await flushAsync();
    expect(oldFake.closeCalls.count).toBe(1);

    nextFake.emitMessage({
      ok: true,
      payload: { conversation_id: 'conv_002', stream_id: 'stream_002' },
      type: 'voice.stream.started',
    } as AssistantServerMessage);
    await nextTurn;

    expect(oldFake.sent).toHaveLength(0);
    expect(deps.capture.start).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({ conversationId: 'conv_002', phase: 'recording' });
  });

  it('cancels a recording without ending the stream or applying a late command', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'recording' });

    await service.cancelTurn();

    expect(deps.capture.stop).toHaveBeenCalledTimes(1);
    expect(fake.sent.filter((message) => message.type === 'voice.stream.end')).toHaveLength(0);
    expect(fake.closeCalls.count).toBe(1);
    expect(service.getState()).toEqual({ phase: 'idle' });

    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_late',
      payload: { operation: 'create_schedule', status: 'applied' },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();
    expect(deps.localScheduleWriter.applyCommandResult).not.toHaveBeenCalled();
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

  it('tags every voice.stream.start with a fresh per-turn request_id', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    await completeStreamStart(fake, service.startTurn());

    const starts = fake.sent.filter((message) => message.type === 'voice.stream.start');
    expect(starts).toHaveLength(2);
    expect(starts[0].request_id).toBeTruthy();
    expect(starts[1].request_id).toBeTruthy();
    expect(starts[1].request_id).not.toBe(starts[0].request_id);
  });

  it('drops a stale reply from the previous turn so it cannot repop the bubble', async () => {
    // 上一轮被新一轮 voice.stream.start 打断时，execute 的 reply/tts 事件可能晚到；
    // 不按 request_id 过滤的话，气泡被点掉后会被这条迟到回复重新弹回来，把输入条
    // 整个挡住（AssistantVoiceOverlay 在有 replyText 时铺了一层全屏点击层）。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    // turn 1：回复到了，用户点掉气泡。计数器是模块级的，用例之间会累加，所以
    // 轮次 id 一律从实际发出的 voice.stream.start 上取，不写死字面量。
    await completeStreamStart(fake, service.startTurn());
    const turn1Id = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn1Id,
      payload: { done: true, reply_id: 'reply_1', speech_text: '第一条回复' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    await service.dismissReply();
    expect(service.getReplyText()).toBeNull();

    // turn 2：新的 stream.start 已经带上不同的 request_id（这里故意不先把新流
    // started 发下去，复现旧事件在新一轮启动窗口里晚到的情形）。
    const nextTurn = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn1Id,
      payload: { done: true, reply_id: 'reply_1', speech_text: '第一条回复' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBeNull();

    // 新 turn 自己的回复到了才显示。
    const starts = fake.sent.filter((message) => message.type === 'voice.stream.start');
    const turn2Id = starts[1].request_id;
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_2', speech_text: '第二条回复' },
      request_id: turn2Id,
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe('第二条回复');

    await completeStreamStart(fake, nextTurn);
  });

  it('keeps the bubble visible while a reply streams, and shows its full text', async () => {
    // 长回复 = 后端分多条 voice.dialogue.reply 流式下发（composed/realtime agent
    // 每次文本增量一条，text 是累计的），最后一条 done=true。气泡应随增量逐步
    // 更新并保持可见，最终显示完整文本。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    const turnId = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;

    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turnId,
      payload: { done: false, reply_id: 'reply_1', speech_text: '好的，明天下午' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe('好的，明天下午');

    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turnId,
      payload: {
        done: false,
        reply_id: 'reply_1',
        speech_text: '好的，明天下午三点在203会议室开会，我会提前十五分钟提醒你',
      },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe(
      '好的，明天下午三点在203会议室开会，我会提前十五分钟提醒你',
    );

    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turnId,
      payload: {
        done: true,
        reply_id: 'reply_1',
        speech_text: '好的，明天下午三点在203会议室开会，我会提前十五分钟提醒你',
      },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe(
      '好的，明天下午三点在203会议室开会，我会提前十五分钟提醒你',
    );
  });

  it('clears the bubble and stops the audio immediately when a new press starts mid-reply', async () => {
    // 产品预期：再次按住说话等于主动放弃上一轮，跟点掉气泡（dismissReply）
    // 是同一个动作——文字气泡立即清空、语音立即停播，然后干净地开始听
    // 新一段，不应该把上一轮的内容留着跟新一轮混在一起。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    // turn 1：回复开始流式，TTS 也开始播。
    await completeStreamStart(fake, service.startTurn());
    const turn1Id = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn1Id,
      payload: { done: false, reply_id: 'reply_1', speech_text: '好的，明天下午' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '好的，明天下午',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe('好的，明天下午');
    expect(deps.playback.startStream).toHaveBeenCalledTimes(1);
    jest.mocked(deps.playback.stop).mockClear();

    // 语音还在播，用户又按住说话 → 新一轮开始：气泡立即清空，语音立即停播。
    const nextTurn = service.startTurn();
    await flushAsync();
    expect(service.getReplyText()).toBeNull();
    expect(deps.playback.stop).toHaveBeenCalledTimes(1);

    // turn 1 剩余的流式增量（还是旧 request_id）晚到：已经被放弃的这一轮，
    // 不能让它重新把气泡填回去。
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn1Id,
      payload: {
        done: true,
        reply_id: 'reply_1',
        speech_text: '好的，明天下午三点在203会议室开会，我会提前十五分钟提醒你',
      },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBeNull();

    await completeStreamStart(fake, nextTurn);

    // turn 2 自己的回复到了才显示。
    const turn2Id = fake.sent.filter((message) => message.type === 'voice.stream.start')[1]
      .request_id;
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn2Id,
      payload: { done: true, reply_id: 'reply_2', speech_text: '好的，帮你查一下' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe('好的，帮你查一下');
  });

  it("does not let a stale tts.end from an abandoned turn clobber the new turn's phase", async () => {
    // 同类问题：voice.tts.start/voice.tts.end 协议里不带 request_id，没法像
    // voice.dialogue.reply 那样按轮次门控。turn 1 的语音还没播完，用户又按住
    // 说话开始 turn 2——turn 1 的音频应该被主动掐掉；turn 1 迟到的 tts.end
    // 不能把已经推进到 turn 2 的 phase 强行掰回 idle。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    // turn 1：语音开始播。
    await completeStreamStart(fake, service.startTurn());
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'speaking' });
    jest.mocked(deps.playback.stop).mockClear();

    // 语音还没播完，用户又按住说话 → turn 2 开始：应该主动掐掉 turn 1 的播放。
    const nextTurn = service.startTurn();
    await flushAsync();
    expect(deps.playback.stop).toHaveBeenCalledTimes(1);

    await completeStreamStart(fake, nextTurn);
    expect(service.getState()).toMatchObject({ phase: 'recording' });

    // turn 1 迟到的 tts.end 到达：不能把 phase 掰回 idle。
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'recording' });
  });

  it('tracks every abandoned audio id, not just the most recently abandoned one', async () => {
    // 连续按两次：turn 1 的音频 A 还没等到自己的 tts.end，就被 turn 2 自己的
    // 音频 B 顶替成"当前正在播的"，然后 turn 2 也被 turn 3 打断——B 被放弃时
    // 如果放弃记录只存一个值，会把 A 那条覆盖掉，A 迟到的 tts.end 就会落进
    // 正常分支，把已经推进到 turn 3 的 phase 错误地掰回 idle。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    // turn 1：音频 A 开始播。
    await completeStreamStart(fake, service.startTurn());
    fake.emitMessage({
      audio_id: 'audio_a',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();

    // turn 2 开始：A 被放弃。
    await completeStreamStart(fake, service.startTurn());

    // turn 2 自己的音频 B 开始播。
    fake.emitMessage({
      audio_id: 'audio_b',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();

    // turn 3 开始：B 也被放弃，此时 A 还没等到自己的 tts.end。
    await completeStreamStart(fake, service.startTurn());
    expect(service.getState()).toMatchObject({ phase: 'recording' });

    // A 迟到的 tts.end 到达：不能把已经推进到 turn 3 的 phase 掰回 idle。
    fake.emitMessage({
      audio_id: 'audio_a',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'recording' });

    // B 迟到的 tts.end 到达：同样不能把 phase 掰回 idle。
    fake.emitMessage({
      audio_id: 'audio_b',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'recording' });
  });

  it('abandons the currently-playing audio when dismissReply() is called mid-speech', async () => {
    // dismissReply() 点掉气泡时如果语音还在播，也要走跟新一轮开始时一样的
    // 放弃流程：立即停播、把这条 audio_id 记进 abandonedAudioIds，不然它
    // 迟到的 tts.end 会落进正常分支，把点掉气泡之后的状态又碰一遍。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'speaking' });
    jest.mocked(deps.playback.stop).mockClear();

    await service.dismissReply();
    expect(deps.playback.stop).toHaveBeenCalledTimes(1);

    // 点掉之后开始新一轮。
    await completeStreamStart(fake, service.startTurn());
    expect(service.getState()).toMatchObject({ phase: 'recording' });

    // 被放弃的那条音频迟到的 tts.end 到达：不能把 phase 掰回 idle。
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toMatchObject({ phase: 'recording' });
  });

  it('still stops playback when a new press lands in the gap between two TTS segments', async () => {
    // 长回复的 TTS 可能分好几段下发（一句一个 tts.start/tts.end）。如果按下
    // 的瞬间恰好卡在上一段 tts.end 和下一段 tts.start 之间，currentAudioId
    // 这时候是 null——stop() 之前是放在 `if (currentAudioId !== null)` 里面
    // 调用的，这种情况下会被跳过，原生播放器收不到停止指令，眼睁睁看着它
    // 继续播下一段。stop() 现在挪到 if 外面、无条件调用，不依赖这个判断。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm',
        purpose: 'command_result',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();

    // 第一段说完，收尾——currentAudioId 回到 null，但原生播放器可能还没真正
    // 播完硬件缓冲区里的音频，下一段的 tts.start 也还没到。
    fake.emitMessage({
      audio_id: 'audio_1',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();
    jest.mocked(deps.playback.stop).mockClear();

    // 恰好在这个间隙按住说话：即使没有正在追踪的 audio_id，也要把 stop()
    // 发出去。
    await completeStreamStart(fake, service.startTurn());
    expect(deps.playback.stop).toHaveBeenCalledTimes(1);
  });

  it('shows a clarifying question as the reply bubble, even though TTS plays it independently', async () => {
    // 用户报告：问"有什么"能看到气泡，问"删除某一个"（触发确认类追问）
    // 听得见语音但看不见气泡，也点不了。voice.dialogue.question 之前只写
    // state.speechText，气泡 UI（AssistantVoiceOverlay）只读 replyText——
    // 两个完全独立的字段，追问从来没被接进气泡显示逻辑。这跟打断/连续按
    // 没有关系，是这条消息类型本身漏了这一步。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    const turnId = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turnId,
      payload: {
        candidates: [],
        question_id: 'q_1',
        question_kind: 'confirmation',
        speech_text: '确认要删除这条日程吗？',
      },
      type: 'voice.dialogue.question',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getReplyText()).toBe('确认要删除这条日程吗？');
    expect(service.getState()).toMatchObject({ phase: 'asking' });
  });

  it("drops a stale dialogue.question from a previous turn so it cannot hijack the new turn's phase", async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    const turn1Id = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;

    const nextTurn = service.startTurn();
    await flushAsync();
    const stateBeforeStaleQuestion = service.getState();

    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: turn1Id,
      payload: {
        candidates: [],
        question_id: 'q_1',
        question_kind: 'missing_field',
        speech_text: '你是想订哪一天的会议室？',
      },
      type: 'voice.dialogue.question',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getState()).toEqual(stateBeforeStaleQuestion);

    await completeStreamStart(fake, nextTurn);
    expect(service.getState()).toMatchObject({ phase: 'recording' });
  });

  it('still shows a reply whose request_id is null', async () => {
    // 后端 model_dump() 把缺省的 request_id 序列化成 null（不是省掉字段），所以
    // null 必须当作"不知道是哪一轮"放行，否则回复永远显示不出来。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_1', speech_text: '没带轮次的回复' },
      request_id: null,
      type: 'voice.dialogue.reply',
    } as unknown as AssistantServerMessage);
    await flushAsync();

    expect(service.getReplyText()).toBe('没带轮次的回复');
  });

  it('resolves startTurn on a transport error that carries a stale request_id', async () => {
    // 错误信封也带 request_id，而且可能是上一条流的（后端 voice_stream.py 的
    // "A stream is already active" / "Audio frame is empty" 都会这样）。这条路径
    // 是 startTurn() 唯一的解套机会，按轮次丢掉它会让按住说话永久卡死。
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantConversationService({ accountId: 'acc_001' }, deps);

    await completeStreamStart(fake, service.startTurn());
    const staleId = fake.sent.filter((message) => message.type === 'voice.stream.start')[0]
      .request_id;
    const turn = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      error: { code: 'X', message: 'A stream is already active for this session' },
      ok: false,
      request_id: staleId,
    } as AssistantServerMessage);

    await expect(turn).resolves.toBeUndefined();
    expect(service.getState()).toEqual({
      message: 'A stream is already active for this session',
      phase: 'error',
    });
  });
});
