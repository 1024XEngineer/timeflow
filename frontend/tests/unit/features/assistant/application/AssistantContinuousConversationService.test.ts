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

describe('AssistantContinuousConversationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ends the turn once the idle timeout elapses without further speech', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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

  it('resets the idle timer after a reply finishes playing', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    service.dispose();
  });

  it('stops forwarding microphone frames while paused, and resumes them after togglePause()', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    service.dispose();
  });

  it('auto-pauses an active call when the app moves to the background', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    await startListening(fake, service);
    deps.emitAppState('background');

    expect(service.getState()).toEqual({ conversationId: 'conv_001', phase: 'paused' });
    const chunk = new ArrayBuffer(4);
    deps.emitMicChunk(chunk);
    expect(fake.sentAudioFrames).toHaveLength(0);
    service.dispose();
  });

  it('ignores a background transition while idle', () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    deps.emitAppState('background');

    expect(service.getState()).toEqual({ phase: 'idle' });
  });

  it('dispose() clears the idle timer and unsubscribes from app state changes', async () => {
    jest.useFakeTimers();
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    await startListening(fake, service);
    service.dispose();
    await advanceAndFlush(SESSION_IDLE_TIMEOUT_MS);

    expect(deps.unsubscribeAppState).toHaveBeenCalled();
    // endTurn() 里的 capture.stop() 已经在 dispose() 内被兜底调用过一次；
    // 计时器被清掉之后，超时窗口走完不应该再触发第二次。
    expect(deps.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('resets muted state on a fresh startTurn() even if the previous call ended while paused', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

    await startListening(fake, service);
    service.togglePause();
    await service.endTurn();

    await startListening(fake, service);
    const chunk = new ArrayBuffer(4);
    deps.emitMicChunk(chunk);

    expect(fake.sentAudioFrames).toHaveLength(1);
    service.dispose();
  });

  it('guards endTurn() against being run twice concurrently', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);
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
    service.dispose();
  });

  it('waits for startStream() to finish before pushing the first audio chunk', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);
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
    service.dispose();
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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
    service.dispose();
  });

  it('ends the server stream and closes the connection when capture.start() rejects', async () => {
    const fake = createFakeConnection();
    const deps = createDeps({ connection: fake.connection });
    deps.capture.start = jest.fn(async () => {
      throw new Error('native recording failed to start');
    });
    const service = new AssistantContinuousConversationService({ accountId: 'acc_001' }, deps);

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
