import { isTransportError, type AssistantServerMessage } from '../../../contracts/conversation';
import type { AppliedCommand, ConversationTurnState } from '../domain/ConversationTurn';

import type {
  AssistantApplicationDependencies,
  AssistantApplicationOptions,
  AssistantApplicationPort,
} from './interfaces/AssistantApplicationPort';
import type { VoiceTransportConnection } from './interfaces/VoiceTransportPort';

const AUDIO_FORMAT = 'pcm_s16le';
const SAMPLE_RATE_HZ = 16000;
const CHANNELS = 1;
// 服务端握手超时默认 5s（TIMEFLOW_WS_HANDSHAKE_TIMEOUT_SECONDS）；定位留出一部分
// 预算，超时就不带，不能让 hello 本身也赶不上。
const LOCATION_TIMEOUT_MS = 2000;

/**
 * 一次"按住说话"编排的真实实现，按 AGENTS.md 第 6 节的时序把 transport / capture /
 * playback / location 四个端口串起来。展示层（useAssistantConversation）只订阅
 * 状态，不用理解握手、streamId、TTS 分片这些细节。
 */
export class AssistantConversationService implements AssistantApplicationPort {
  private connection: VoiceTransportConnection | null = null;
  private state: ConversationTurnState = { phase: 'idle' };
  private lastAppliedCommand: AppliedCommand | null = null;
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  private conversationId: string | null = null;
  private streamId: string | null = null;
  /** 非 null 表示当前正处于 voice.tts.start 和 voice.tts.end 之间。 */
  private currentAudioId: string | null = null;
  private streamStartedWaiter: ((conversationId: string) => void) | null = null;
  /** voice.dialogue.reply 的流式文字，展示层拿来当气泡内容；新一轮开始时清空。 */
  private replyText: string | null = null;
  /** 当前这一帧麦克风音量（dBFS），给波形展示；不在录音时是 null。 */
  private soundLevel: number | null = null;
  // 展示层的 onPressIn/onPressOut 不等待彼此:快速按放会让 endTurn() 在
  // streamId/conversationId 还没就绪时执行。endTurn() 等这个 promise，把两者
  // 重新串成先后顺序，而不是让 endTurn() 在它们仍是 null 时静默不做事。
  private pendingStartTurn: Promise<void> | null = null;

  constructor(
    private readonly options: AssistantApplicationOptions,
    private readonly deps: AssistantApplicationDependencies,
  ) {}

  getState(): ConversationTurnState {
    return this.state;
  }

  subscribe(listener: (state: ConversationTurnState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLastAppliedCommand(): AppliedCommand | null {
    return this.lastAppliedCommand;
  }

  getReplyText(): string | null {
    return this.replyText;
  }

  getSoundLevel(): number | null {
    return this.soundLevel;
  }

  async startTurn(): Promise<void> {
    const run = this._startTurn();
    this.pendingStartTurn = run;
    try {
      await run;
    } finally {
      if (this.pendingStartTurn === run) {
        this.pendingStartTurn = null;
      }
    }
  }

  private async _startTurn(): Promise<void> {
    this.replyText = null;
    this.soundLevel = null;
    if (this.connection === null) {
      this.setState({ phase: 'connecting' });
      await this.connect();
    }
    const connection = this.requireConnection();

    const started = new Promise<string>((resolve) => {
      this.streamStartedWaiter = resolve;
    });
    connection.send({
      payload: {
        audio_format: AUDIO_FORMAT,
        channels: CHANNELS,
        conversation_id: this.conversationId ?? undefined,
        sample_rate_hz: SAMPLE_RATE_HZ,
      },
      type: 'voice.stream.start',
    });
    const conversationId = await started;

    await this.deps.capture.requestPermission();
    await this.deps.capture.start((chunk, soundLevel) => {
      connection.sendAudioFrame(chunk);
      this.soundLevel = soundLevel;
      this.notifyListeners();
    });
    this.setState({ conversationId, phase: 'recording' });
  }

  async endTurn(): Promise<void> {
    if (this.pendingStartTurn !== null) {
      await this.pendingStartTurn.catch(() => undefined);
    }
    await this.deps.capture.stop();
    this.soundLevel = null;
    const connection = this.connection;
    if (connection !== null && this.streamId !== null) {
      connection.send({
        payload: { stream_id: this.streamId },
        type: 'voice.stream.end',
      });
      this.streamId = null;
    }
    if (this.conversationId !== null) {
      this.setState({ conversationId: this.conversationId, phase: 'awaiting_result' });
    }
  }

  async dismissReply(): Promise<void> {
    this.replyText = null;
    this.currentAudioId = null;
    this.notifyListeners();
    await this.deps.playback.stop().catch(() => {});
  }

  dispose(): void {
    this.listeners.clear();
    this.connection?.close();
    this.connection = null;
  }

  private async connect(): Promise<void> {
    // 定位放在开连接之前:服务端握手超时从 socket 打开那一刻起计时,原生定位
    // (尤其冷启动 GPS)可能耗时数秒,放在连接之后拿会把这段时间算进握手预算,
    // 导致 hello 送达前就被服务端以 1008 断开。超时兜底,拿不到就不带,不阻塞握手。
    const sample = await Promise.race([
      this.deps.location.getCurrentSample().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS)),
    ]);

    const connection = await this.deps.transport.connect(this.options.wsUrl);
    this.connection = connection;
    connection.onMessage((message) => this.handleMessage(message));
    connection.onAudioFrame((chunk) => this.handleAudioFrame(chunk));
    connection.onClose((event) => this.handleClose(event));

    const ready = new Promise<void>((resolve) => {
      const unsubscribe = connection.onMessage((message) => {
        if (message.type === 'session.ready') {
          unsubscribe();
          resolve();
        }
      });
    });
    connection.send({
      payload: {
        access_token: this.options.accessToken,
        device_id: this.options.deviceId,
        latitude: sample?.latitude,
        longitude: sample?.longitude,
      },
      type: 'session.hello',
    });
    await ready;
  }

  private handleMessage(message: AssistantServerMessage): void {
    if (isTransportError(message)) {
      this.setState({ message: message.error.message, phase: 'error' });
      return;
    }

    switch (message.type) {
      case 'voice.stream.started':
        this.streamId = message.payload.stream_id;
        this.conversationId = message.payload.conversation_id;
        this.streamStartedWaiter?.(message.payload.conversation_id);
        this.streamStartedWaiter = null;
        return;
      case 'voice.command.result': {
        const command: AppliedCommand = {
          operation: message.payload.operation,
          schedule: message.payload.schedule,
          schedules: message.payload.schedules,
          status: message.payload.status,
        };
        // 写本地库是异步的，不等它：ack 和状态回到 idle 立刻做，避免这轮对话
        // 因为一次 SQLite 写入卡住。lastAppliedCommand 在写库落定后才更新，
        // 这样订阅方（比如日历的 refreshSignal）看到它变化时数据已经写完了。
        void this.applyCommandResultLocally(command);
        if (this.connection !== null) {
          this.connection.send({
            message_id: message.message_id,
            status: 'applied',
            type: 'message.ack',
          });
        }
        this.setState({ phase: 'idle' });
        return;
      }
      case 'voice.dialogue.question':
        this.setState({
          conversationId: message.conversation_id,
          phase: 'asking',
          speechText: message.payload.speech_text,
        });
        return;
      case 'voice.dialogue.reply':
        this.replyText = message.payload.speech_text;
        this.notifyListeners();
        return;
      case 'voice.tts.start':
        this.currentAudioId = message.audio_id;
        this.setState({ conversationId: message.conversation_id, phase: 'speaking' });
        this.deps.playback
          .startStream({
            encoding: 'pcm_s16le',
            sampleRateHz: message.payload.sample_rate_hz,
          })
          .catch(() => {});
        return;
      case 'voice.tts.end':
        this.currentAudioId = null;
        this.deps.playback.endStream().catch(() => {});
        this.setState({ phase: 'idle' });
        return;
      default:
        return;
    }
  }

  private async applyCommandResultLocally(command: AppliedCommand): Promise<void> {
    try {
      await this.deps.localScheduleWriter.applyCommandResult(this.options.accountId, command);
    } catch {
      // 写本地失败不影响这轮对话已经完成；不重试，下次操作会带着新数据重新覆盖。
    }
    this.lastAppliedCommand = command;
    this.notifyListeners();
  }

  private handleAudioFrame(chunk: ArrayBuffer): void {
    if (this.currentAudioId === null) {
      return;
    }
    this.deps.playback.pushChunk(chunk).catch(() => {});
  }

  private handleClose(event: { code: number; reason: string }): void {
    this.connection = null;
    this.setState({ message: event.reason || `连接已断开（${event.code}）`, phase: 'error' });
  }

  private requireConnection(): VoiceTransportConnection {
    if (this.connection === null) {
      throw new Error('startTurn called without an open connection');
    }
    return this.connection;
  }

  private setState(state: ConversationTurnState): void {
    this.state = state;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
