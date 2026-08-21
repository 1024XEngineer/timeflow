import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type {
  AssistantClientMessage,
  AssistantServerMessage,
} from '../../../../../src/contracts/conversation';
import { AssistantContinuousConversationService } from '../../../../../src/features/assistant/application/AssistantContinuousConversationService';
import type { AssistantAudioPlaybackPort } from '../../../../../src/features/assistant/application/interfaces/AssistantAudioPlaybackPort';
import type { AudioCapturePort } from '../../../../../src/features/assistant/application/interfaces/AudioCapturePort';
import type { LocalScheduleWriterPort } from '../../../../../src/features/assistant/application/interfaces/LocalScheduleWriterPort';
import type {
  VoiceTransportConnection,
  VoiceTransportPort,
} from '../../../../../src/features/assistant/application/interfaces/VoiceTransportPort';
import type {
  AppLifecycleStatus,
  AppStateProvider,
} from '../../../../../src/infrastructure/appState/AppStateProvider';
import type { LocationProvider } from '../../../../../src/infrastructure/location/LocationProvider';

const SESSION_IDLE_TIMEOUT_MS = 180_000;

/** 跟 AssistantConversationService.test.ts 用同一套理由：startTurn() 里好几层 await，固定多轮 flush 比猜跳数稳。 */
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
  const sentAudioFrames: ArrayBuffer[] = [];
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
    sendAudioFrame: (chunk) => {
      sentAudioFrames.push(chunk);
    },
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
    sentAudioFrames,
    unsubscribeCalls,
  };
}

function createDeps(
  overrides: {
    applyCommandResult?: () => Promise<void>;
    applyCategoryUpdate?: () => Promise<boolean>;
    connection?: VoiceTransportConnection;
    requestPermission?: () => Promise<boolean>;
  } = {},
) {
  let capturedOnChunk: ((chunk: ArrayBuffer, soundLevel: number | null) => void) | null = null;
  let capturedAppStateListener: ((status: AppLifecycleStatus) => void) | null = null;
  const unsubscribeAppState = jest.fn();

  const transport: VoiceTransportPort = {
    connect: jest.fn(async () => overrides.connection ?? createFakeConnection().connection),
  };
  const capture: AudioCapturePort = {
    requestPermission: jest.fn(overrides.requestPermission ?? (async () => true)),
    start: jest.fn(async (onChunk: (chunk: ArrayBuffer, soundLevel: number | null) => void) => {
      capturedOnChunk = onChunk;
    }),
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
    subscribe: jest.fn((listener: (status: AppLifecycleStatus) => void) => {
      capturedAppStateListener = listener;
      return unsubscribeAppState;
    }),
  };

  return {
    appState,
    capture,
    emitAppState: (status: AppLifecycleStatus) => capturedAppStateListener?.(status),
    emitMicChunk: (chunk: ArrayBuffer, soundLevel: number | null = null) =>
      capturedOnChunk?.(chunk, soundLevel),
    localScheduleWriter,
    location,
    playback,
    transport,
    unsubscribeAppState,
  };
}

async function startListening(
  fake: ReturnType<typeof createFakeConnection>,
  service: AssistantContinuousConversationService,
): Promise<void> {
  const turn = service.startTurn();
  await flushAsync();
  fake.emitMessage({
    ok: true,
    payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
    type: 'voice.stream.started',
  } as AssistantServerMessage);
  await turn;
}

const liveServices: AssistantContinuousConversationService[] = [];

function createService(deps: ReturnType<typeof createDeps>) {
  const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);
  liveServices.push(service);
  return service;
}

function disposeService(service: AssistantContinuousConversationService) {
  const index = liveServices.indexOf(service);
  if (index >= 0) {
    liveServices.splice(index, 1);
  }
  service.dispose();
}

describe('AssistantContinuousConversationService', () => {
  afterEach(() => {
    for (const service of liveServices.splice(0)) {
      disposeService(service);
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('ends the turn once the idle timeout elapses without further speech', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS);

    expect(deps.capture.stop).toHaveBeenCalled();
    expect(fake.sent).toContainEqual({
      payload: { stream_id: 'stream_001' },
      type: 'voice.stream.end',
    });
    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('does not end the turn early when voice.asr.completed keeps resetting the idle timer', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS - 1_000);
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { duration_ms: 800, language: 'zh', transcript: '还在说话' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS - 1_000);

    expect(deps.capture.stop).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ phase: 'listening' });
  });

  it('accumulates transcript/reply pairs into turn history instead of overwriting', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_1',
      payload: { duration_ms: 800, language: 'zh', transcript: '明天几点开会' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_1', speech_text: '明天下午三点' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_2',
      payload: { duration_ms: 500, language: 'zh', transcript: '谁参加' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getMessages()).toEqual([
      { id: 'user-1', role: 'user', text: '明天几点开会' },
      { id: 'reply_1', role: 'assistant', text: '明天下午三点' },
      { id: 'user-3', role: 'user', text: '谁参加' },
    ]);
  });

  it('keeps a streaming assistant reply pending until it is done', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: false, reply_id: 'reply_1', speech_text: '明天' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getMessages()).toEqual([
      { id: 'reply_1', pending: true, role: 'assistant', text: '明天' },
    ]);

    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_1', speech_text: '明天下午三点' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getMessages()).toEqual([
      { id: 'reply_1', role: 'assistant', text: '明天下午三点' },
    ]);
  });

  it('attaches a late reply to the turn it answers, not whichever turn is now last', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_1',
      payload: { duration_ms: 800, language: 'zh', transcript: '明天几点开会' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    // 用户没等 req_1 的回复就开口问了下一句，新一轮先落地成了 turns 里最后一条。
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_2',
      payload: { duration_ms: 500, language: 'zh', transcript: '谁参加' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    // req_1 的回复这时候才迟到到达。
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_1',
      payload: { done: true, reply_id: 'reply_1', speech_text: '明天下午三点' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getTurns()).toEqual([
      { id: 'req_1', replyText: '明天下午三点', transcript: '明天几点开会' },
      { id: 'req_2', replyText: null, transcript: '谁参加' },
    ]);
  });

  it.each([
    ['missing_field', '你是想订哪一天的会议室？'],
    ['ambiguous_target', '你是指三楼小会议室还是五楼大会议室？'],
    ['confirmation', '确认要把这条日程删除吗？'],
  ])(
    'records a clarifying voice.dialogue.question (%s) as the reply for the current turn',
    async (questionKind, speechText) => {
      const fake = createFakeConnection();
      const deps = createDeps({ connection: fake.connection });
      const service = createService(deps);

      await startListening(fake, service);
      fake.emitMessage({
        conversation_id: 'conv_001',
        request_id: 'req_1',
        payload: { duration_ms: 800, language: 'zh', transcript: '帮我订会议室' },
        type: 'voice.asr.completed',
      } as AssistantServerMessage);
      fake.emitMessage({
        conversation_id: 'conv_001',
        payload: {
          candidates: [],
          question_id: 'q_1',
          question_kind: questionKind,
          speech_text: speechText,
        },
        type: 'voice.dialogue.question',
      } as AssistantServerMessage);
      await flushAsync();

      expect(service.getMessages()).toEqual([
        { id: 'user-1', role: 'user', text: '帮我订会议室' },
        { id: 'q_1', role: 'assistant', text: speechText },
      ]);
      expect(service.getState()).toMatchObject({ phase: 'asking' });
    },
  );

  it('records an assistant bubble even when a reply arrives before any transcript', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_1', speech_text: '好的' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getReplyText()).toBe('好的');
    expect(service.getMessages()).toEqual([{ id: 'reply_1', role: 'assistant', text: '好的' }]);
  });

  it('clears turn history when a new call starts', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      request_id: 'req_1',
      payload: { duration_ms: 800, language: 'zh', transcript: '明天几点开会' },
      type: 'voice.asr.completed',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getMessages()).toHaveLength(1);

    await service.endTurn();
    await startListening(fake, service);

    expect(service.getMessages()).toHaveLength(0);
  });

  it('resets the idle timer after a reply finishes playing', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS - 1_000);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS - 1_000);

    expect(deps.capture.stop).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'listening' });
  });

  it('ends the turn when the server reports voice.session.end, without surfacing an error', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      type: 'voice.session.end',
    } as AssistantServerMessage);
    await flushAsync();

    expect(fake.sent).toContainEqual({
      payload: { stream_id: 'stream_001' },
      type: 'voice.stream.end',
    });
    expect(fake.closeCalls.count).toBe(1);
    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('keeps the last successfully persisted command when a later local write fails', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_success',
      payload: {
        operation: 'create_schedule',
        schedule: { id: 'persisted' },
        status: 'applied',
      },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getLastAppliedCommand()).toEqual(
      expect.objectContaining({ operation: 'create_schedule', schedule: { id: 'persisted' } }),
    );
    const applyCommandResult = deps.localScheduleWriter.applyCommandResult as jest.MockedFunction<
      LocalScheduleWriterPort['applyCommandResult']
    >;
    applyCommandResult.mockRejectedValueOnce(new Error('disk full'));
    fake.emitMessage({
      conversation_id: 'conv_001',
      message_id: 'msg_failed',
      payload: {
        operation: 'create_schedule',
        schedule: { id: 'not-persisted' },
        status: 'applied',
      },
      type: 'voice.command.result',
    } as AssistantServerMessage);
    await flushAsync();

    expect(service.getLastAppliedCommand()).toEqual(
      expect.objectContaining({ operation: 'create_schedule', schedule: { id: 'persisted' } }),
    );
    expect(fake.sent).toContainEqual({
      message_id: 'msg_success',
      status: 'applied',
      type: 'message.ack',
    });
    expect(fake.sent).not.toContainEqual(
      expect.objectContaining({ message_id: 'msg_failed', type: 'message.ack' }),
    );
    disposeService(service);
  });

  it('keeps applying queued command results even if a subscriber listener throws', async () => {
    // markScheduleDataChanged() synchronously notifies every subscriber; a listener
    // that throws (e.g. a buggy re-render) rejects applyCommandResultLocally()'s
    // promise. queueCommandResult() must neutralize that with .catch(() => {})
    // chained in the same statement (same idiom as chainPlayback) -- deferring the
    // catch to a later call leaves the rejection unhandled for a few microtask
    // ticks, which crashes the process outright (reproduced while writing this
    // test, before adding the immediate .catch()).
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);
    await startListening(fake, service);

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
    disposeService(service);
  });

  it('serializes local writes so a batch of back-to-back command results cannot race', async () => {
    // Regression test for a batch create/delete race: the model can call several
    // tools inside one turn, so voice.command.result messages can arrive only
    // milliseconds apart (observed as low as 12ms in production logs). Each write
    // opens its own withExclusiveTransactionAsync() on the real SQLite adapter --
    // running two at once opens two native connections that fight over the same
    // exclusive lock ("database is locked"), and the loser's write is silently
    // dropped even though the cloud already committed it. queueCommandResult()
    // must serialize these instead of firing them concurrently.
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
    const service = createService(deps);
    await startListening(fake, service);

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
    disposeService(service);
  });

  it('patches an asynchronous category update while the call remains active', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);
    expect(service.getScheduleDataRevision()).toBe(0);

    await startListening(fake, service);
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
    expect(service.getState()).toMatchObject({ phase: 'listening' });
    service.dispose();
  });

  it('applies a buffered category after the command result creates the local row', async () => {
    const fake = createFakeConnection();
    const applyCategoryUpdate = jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deps = createDeps({ applyCategoryUpdate, connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    await startListening(fake, service);
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
    service.dispose();
  });

  it('does not retain a category update that finishes after dispose', async () => {
    const fake = createFakeConnection();
    let finishPatch!: () => void;
    const pendingPatch = new Promise<boolean>((resolve) => {
      finishPatch = () => resolve(false);
    });
    const applyCategoryUpdate = jest.fn<() => Promise<boolean>>(() => pendingPatch);
    const deps = createDeps({ applyCategoryUpdate, connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    await startListening(fake, service);
    fake.emitMessage({
      payload: { category: 'work', schedule_id: 'schedule_001' },
      type: 'schedule.category.updated',
    } as AssistantServerMessage);
    await flushAsync();
    service.dispose();
    finishPatch();
    await flushAsync();

    expect(applyCategoryUpdate).toHaveBeenCalledTimes(1);
  });

  it('stops forwarding microphone frames while paused, and resumes them after togglePause()', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    const chunk = new ArrayBuffer(4);
    deps.emitMicChunk(chunk);
    expect(fake.sentAudioFrames).toHaveLength(1);

    service.togglePause();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'paused' });
    deps.emitMicChunk(chunk);
    expect(fake.sentAudioFrames).toHaveLength(1);

    service.togglePause();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'listening' });
    deps.emitMicChunk(chunk);
    expect(fake.sentAudioFrames).toHaveLength(2);
    // 关掉 startListening() 里 armIdleTimer() 挂的真实 setTimeout，不然会在
    // 进程里悬空，让 jest 报"未正常退出"。
    disposeService(service);
  });

  it('auto-pauses an active call when the app moves to the background', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    deps.emitAppState('background');

    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'paused' });
    const chunk = new ArrayBuffer(4);
    deps.emitMicChunk(chunk);
    expect(fake.sentAudioFrames).toHaveLength(0);
    disposeService(service);
  });

  it('ignores a background transition while idle', () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    deps.emitAppState('background');

    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('dispose() clears the idle timer and unsubscribes from app state changes', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    disposeService(service);
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS);

    expect(deps.unsubscribeAppState).toHaveBeenCalled();
    // endTurn() 里的 capture.stop() 已经在 dispose() 内被兜底调用过一次；
    // 计时器被清掉之后，超时窗口走完不应该再触发第二次。
    expect(deps.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('resets muted state on a fresh startTurn() even if the previous call ended while paused', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    service.togglePause();
    await service.endTurn();

    await startListening(fake, service);
    const chunk = new ArrayBuffer(4);
    deps.emitMicChunk(chunk);

    expect(fake.sentAudioFrames).toHaveLength(1);
    disposeService(service);
  });

  it('guards endTurn() against being run twice concurrently', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    const first = service.endTurn();
    const second = service.endTurn();
    await Promise.all([first, second]);

    expect(fake.closeCalls.count).toBe(1);
    expect(fake.sent.filter((message) => message.type === 'voice.stream.end')).toHaveLength(1);
    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('still tears the call down when capture.stop() rejects', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    deps.capture.stop = jest.fn(async () => {
      throw new Error('native stop failed');
    });
    const service = createService(deps);

    await startListening(fake, service);
    await service.endTurn();

    expect(fake.sent).toContainEqual({
      payload: { stream_id: 'stream_001' },
      type: 'voice.stream.end',
    });
    expect(fake.closeCalls.count).toBe(1);
    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('serializes pushChunk() calls so a slow chunk cannot be overtaken by the next one', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);
    const calls: number[] = [];
    let resolveFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    (deps.playback.pushChunk as jest.Mock)
      .mockImplementationOnce(async () => {
        calls.push(1);
        await first;
      })
      .mockImplementationOnce(async () => {
        calls.push(2);
      });

    await startListening(fake, service);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();

    fake.emitAudioFrame(new ArrayBuffer(4));
    fake.emitAudioFrame(new ArrayBuffer(4));
    await flushAsync();

    // 第一块还没写完，第二块不该被喂进去。
    expect(calls).toEqual([1]);

    resolveFirst();
    await flushAsync();

    expect(calls).toEqual([1, 2]);
    disposeService(service);
  });

  it('waits for startStream() to finish before pushing the first audio chunk', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);
    const calls: string[] = [];
    let resolveStart: () => void = () => {};
    (deps.playback.startStream as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    (deps.playback.pushChunk as jest.Mock).mockImplementation(async () => {
      calls.push('pushChunk');
    });

    await startListening(fake, service);
    calls.push('startStream');
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    fake.emitAudioFrame(new ArrayBuffer(4));
    await flushAsync();

    // startStream() 还没写完(原生侧还在配置)，pushChunk() 不该抢先被喂进去。
    expect(calls).toEqual(['startStream']);

    resolveStart();
    await flushAsync();

    expect(calls).toEqual(['startStream', 'pushChunk']);
    disposeService(service);
  });

  it('stops immediately and drops queued chunks when TTS is canceled', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);
    const calls: string[] = [];
    let resolveFirst: () => void = () => {};
    (deps.playback.pushChunk as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            calls.push('push-1');
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        calls.push('push-2');
      });
    (deps.playback.stop as jest.Mock).mockImplementation(async () => {
      calls.push('stop');
    });

    await startListening(fake, service);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();
    fake.emitAudioFrame(new ArrayBuffer(4));
    fake.emitAudioFrame(new ArrayBuffer(4));
    await flushAsync();

    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.canceled',
    } as AssistantServerMessage);
    expect(calls).toEqual(['push-1', 'stop']);

    resolveFirst();
    await flushAsync();

    // push-2 已经排在链上，但代次已经变了，必须被丢掉而不是补喂给播放器。
    expect(calls).toEqual(['push-1', 'stop']);
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'interrupted' });
    disposeService(service);
  });

  it('ignores the canceled stream end that arrives after interruption', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.canceled',
    } as AssistantServerMessage);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    await flushAsync();

    expect(deps.playback.endStream).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'interrupted' });
    disposeService(service);
  });

  it('does not stop a newer TTS when a late cancellation belongs to the old audio', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    const startMessage = (audioId: string): AssistantServerMessage =>
      ({
        audio_id: audioId,
        conversation_id: 'conv_001',
        payload: {
          format: 'pcm_s16le',
          purpose: 'reply',
          sample_rate_hz: 24000,
          speech_text: '',
        },
        type: 'voice.tts.start',
      }) as AssistantServerMessage;

    fake.emitMessage(startMessage('audio_001'));
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.end',
    } as AssistantServerMessage);
    fake.emitMessage(startMessage('audio_002'));
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      type: 'voice.tts.canceled',
    } as AssistantServerMessage);
    // 兼容尚未升级的后端：旧实现把这种晚到的取消发成空 id，不能把新流停掉。
    fake.emitMessage({
      audio_id: '',
      conversation_id: 'conv_001',
      type: 'voice.tts.canceled',
    } as AssistantServerMessage);
    await flushAsync();

    expect(deps.playback.stop).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'speaking' });
    disposeService(service);
  });

  it('dismissReply() clears the reply bubble and stops playback immediately', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    await startListening(fake, service);
    fake.emitMessage({
      audio_id: 'audio_001',
      conversation_id: 'conv_001',
      payload: {
        format: 'pcm_s16le',
        purpose: 'reply',
        sample_rate_hz: 24000,
        speech_text: '回复内容',
      },
      type: 'voice.tts.start',
    } as AssistantServerMessage);
    await flushAsync();
    fake.emitMessage({
      conversation_id: 'conv_001',
      payload: { done: true, reply_id: 'reply_1', speech_text: '回复内容' },
      type: 'voice.dialogue.reply',
    } as AssistantServerMessage);
    await flushAsync();
    expect(service.getReplyText()).toBe('回复内容');

    await service.dismissReply();

    expect(service.getReplyText()).toBeNull();
    expect(deps.playback.stop).toHaveBeenCalledTimes(1);
    disposeService(service);
  });

  it('handleClose() unsubscribes from the shared connection before nulling it, even when a real disconnect races endTurn()', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    let resolveStop: () => void = () => {};
    deps.capture.stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const service = createService(deps);

    await startListening(fake, service);
    const ending = service.endTurn();
    // 挂断卡在 capture.stop() 的 await 上时，服务端把连接真的断了——这条真实
    // 断线事件必须自己把三个监听器从共享连接上摘掉，不能指望 endTurn() 后面
    // 还没跑到的那次 unsubscribeConnection?.()，那时 this.unsubscribeConnection
    // 已经被这里置空了。
    fake.emitClose({ code: 1000, reason: '' });
    resolveStop();
    await ending;

    expect(fake.unsubscribeCalls).toEqual({ audio: 1, close: 1, message: 1 });
  });

  it('guards startTurn() against being run twice concurrently', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = createService(deps);

    // 一次点击触发两次 startTurn()（比如双击）：没有门槛的话第二次会覆盖
    // this.connection/streamStartedWaiter，第一次的连接监听器就永久泄漏了。
    const first = service.startTurn();
    const second = service.startTurn();
    await flushAsync();
    fake.emitMessage({
      ok: true,
      payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
      type: 'voice.stream.started',
    } as AssistantServerMessage);
    await Promise.all([first, second]);

    expect(deps.transport.connect).toHaveBeenCalledTimes(1);
    expect(fake.sent.filter((message) => message.type === 'voice.stream.start')).toHaveLength(1);
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'listening' });
    disposeService(service);
  });

  it('ends the server stream and closes the connection when capture.start() rejects', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    deps.capture.start = jest.fn(async () => {
      throw new Error('native recording failed to start');
    });
    const service = createService(deps);

    const turn = service.startTurn();
    await flushAsync();
    // 服务端已经确认开流了（stream_id 拿到手），然后原生录音才失败——这正是
    // 会把连接卡在"有一条活跃流"的时序。
    fake.emitMessage({
      ok: true,
      payload: { conversation_id: 'conv_001', stream_id: 'stream_001' },
      type: 'voice.stream.started',
    } as AssistantServerMessage);
    await expect(turn).rejects.toThrow('native recording failed to start');

    expect(fake.sent).toContainEqual({
      payload: { stream_id: 'stream_001' },
      type: 'voice.stream.end',
    });
    expect(fake.closeCalls.count).toBe(1);
    expect(fake.unsubscribeCalls).toEqual({ audio: 1, close: 1, message: 1 });
    expect(service.getState()).toEqual({ message: '录音启动失败', phase: 'error' });

    // 重试必须能重新打开一条连接，不是卡在上一条已经关掉的连接上；这次原生录音
    // 能正常启动了。
    const fakeRetry = createFakeConnection();
    const connectMock = deps.transport.connect as jest.MockedFunction<
      typeof deps.transport.connect
    >;
    connectMock.mockResolvedValueOnce(fakeRetry.connection);
    let retryOnChunk: ((chunk: ArrayBuffer, soundLevel: number | null) => void) | null = null;
    const captureStartMock = deps.capture.start as jest.MockedFunction<typeof deps.capture.start>;
    captureStartMock.mockImplementationOnce(async (onChunk) => {
      retryOnChunk = onChunk;
    });
    await startListening(fakeRetry, service);
    expect(retryOnChunk).not.toBeNull();
    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'listening' });
  });
});
